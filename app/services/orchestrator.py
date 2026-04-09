#!/usr/bin/env python3
"""Orchestrator — git checkpoints, async GOD, session persistence."""

import os
import sys
import time
from pathlib import Path

from app.models.agent import AgentDef
from app.models.flow import Flow
from app.models.header import DEFAULT_PROTOCOL_ID
from app.core.agent import Agent
from app.core.protocol import parse
from app.core.god import GodAgent, build_summary, GodCommand
from app.core.checkpoint import GitCheckpoint
from app.core.swarm_state import SwarmState, save_swarm, load_swarm_state, resume_agent
from app.config import (
    PROTOCOL_INSTRUCTIONS, GOD_PERSONA,
    MAX_HANDOFF_ROUNDS, MIN_RESPONSE_LEN, MAX_RETRIES,
    MAX_SIGNAL_NUDGES, NUDGE_MESSAGE,
)
from app.utils.logger import Logger
from app.services import registry, flow_service, header_service, data_collector
from app.services.agent_helpers import resolve_header_ids, compose_persona, build_agent_list_for


def _init_agent(defn: AgentDef, agent_list: str, workdir: str, log: Logger, header_ids: list[str] | None = None) -> Agent:
    agent = Agent(defn.name, workdir, defn.model)
    agent.start()
    persona = compose_persona(defn, header_ids or [DEFAULT_PROTOCOL_ID], agent_list)
    persona += '\n\nResponda apenas: "Entendido." Nada mais.'
    agent.send(persona)
    log.agent(defn.name, 'ready', f'workdir: {workdir}')
    return agent


def _handle_signal(signal, current_id, defn, flow, log, agent_map=None, return_stack=None):
    """Returns (action, next_id, next_msg). action: 'continue' | 'break'."""
    if signal.kind == 'handoff':
        allowed = flow.targets_for(current_id)
        if signal.target not in allowed:
            log.error(f'Handoff to "{signal.target}" blocked by flow')
            return ('break', '', '')
        if return_stack is not None and flow.edge_returns(current_id, signal.target):
            return_stack.append(current_id)
            log.orch(f'↩ {signal.target} (retorno obrigatório para {defn.name})')
        else:
            log.orch(f'Handoff → {signal.target}: {signal.summary}')
        msg = (
            f"O agente {defn.name} completou sua parte e passou para você:\n\n"
            f"---\n{signal.clean_response}\n---\n\n"
            f"Contexto do handoff: {signal.summary}"
        )
        return ('continue', signal.target, msg)
    elif signal.kind == 'done':
        if return_stack:
            sender_id = return_stack.pop()
            sender_name = agent_map[sender_id].name if agent_map and sender_id in agent_map else sender_id
            log.orch(f'↩ {defn.name} finalizou, retornando para {sender_name}')
            return ('continue', sender_id, f"[Retorno de {defn.name}] {signal.summary}")
        log.orch(f'Done! {defn.name}: {signal.summary}')
        return ('break', '', '')
    return ('break', '', '')


def _send_with_retry(agent: Agent, message: str, log: Logger) -> str:
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = agent.send(message)
            if len(response.strip()) >= MIN_RESPONSE_LEN:
                return response
            log.error(f'{agent.name}: short response ({len(response)}c), retry {attempt+1}')
        except Exception as e:
            log.error(f'{agent.name}: {e}, retry {attempt+1}')
            if attempt == MAX_RETRIES:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError(f'{agent.name}: failed after {MAX_RETRIES+1} attempts')


def run_swarm(question: str, workdir: str = '.', flow: Flow | None = None, log: Logger | None = None, resume: bool = False, flow_id: str | None = None) -> list[dict]:
    if log is None:
        log = Logger()
    flow_def = None
    if flow is None:
        fd = flow_service.get(flow_id) if flow_id else None
        flow_def = fd
        flow = fd.flow if fd else flow_service.load()

    workdir = os.path.abspath(workdir)
    agent_defs = registry.load()
    agent_map = {a.id: a for a in agent_defs}
    header_service.ensure_defaults()

    saved = load_swarm_state(workdir) if resume else None
    if saved:
        log.orch(f'Resuming from round {saved.round_num}, agent: {saved.current_agent_id}')

    if not flow.nodes:
        raise ValueError('Flow has no nodes')

    start_id = saved.current_agent_id if saved else flow.start_agent()
    flow_ids = {n.agent_id for n in flow.nodes}
    log.orch(f'Workdir: {workdir}')
    log.orch(f'Flow: {len(flow.nodes)} nodes, {len(flow.edges)} edges, start: {start_id}')

    git = GitCheckpoint(workdir)
    git_enabled = git.init()
    if git_enabled:
        log.orch('Git checkpoints enabled')
    else:
        log.orch('Git not available — no code rollback')

    live_agents: dict[str, Agent] = {}
    god: GodAgent | None = None
    errors: list[str] = []
    agent_call_history: list[str] = []
    commit_hashes: dict[int, str] = {}

    try:
        log.orch('Spawning GOD_AGENT...')
        god = GodAgent(workdir)
        god.start(GOD_PERSONA)
        log.agent('GOD', 'ready', 'Watchdog async')

        for nid in flow_ids:
            defn = agent_map.get(nid)
            if not defn:
                continue
            if saved and nid in saved.agent_ids:
                log.orch(f'Resuming {defn.name}...')
                live_agents[nid] = resume_agent(nid, defn.name, workdir, defn.model)
                log.agent(defn.name, 'resumed', '')
            else:
                agent_list = build_agent_list_for(nid, agent_defs, flow)
                log.orch(f'Spawning {defn.name}...')
                hids = resolve_header_ids(nid, flow, flow_def)
                live_agents[nid] = _init_agent(defn, agent_list, workdir, log, hids)

        current_id = start_id
        message = saved.pending_message if saved and saved.pending_message else question
        round_num = saved.round_num if saved else 0
        commit_hashes = saved.commit_hashes if saved else {}
        return_stack = []

        while round_num < MAX_HANDOFF_ROUNDS:
            round_num += 1

            cmd = god.poll_command() if god else None
            while cmd:
                log.agent('GOD', '→ action', f'@{cmd.action}({cmd.target}): {cmd.payload[:60]}' if cmd.payload else f'@{cmd.action}({cmd.target})')
                if cmd.action == 'restart' and cmd.target in live_agents:
                    log.orch(f'👁 GOD: restarting {cmd.target}')
                    live_agents[cmd.target].quit()
                    defn = agent_map[cmd.target]
                    agent_list = build_agent_list_for(cmd.target, agent_defs, flow)
                    hids = resolve_header_ids(cmd.target, flow, flow_def)
                    live_agents[cmd.target] = _init_agent(defn, agent_list, workdir, log, hids)
                elif cmd.action == 'compact' and cmd.target in live_agents:
                    log.orch(f'👁 GOD: compacting {cmd.target}')
                    compact_msg = f'/compact {cmd.payload}' if cmd.payload else '/compact'
                    live_agents[cmd.target]._pty.write(compact_msg + '\r')
                    live_agents[cmd.target]._read_until_prompt(timeout=60)
                elif cmd.action == 'stop' and cmd.target in live_agents:
                    log.orch(f'👁 GOD: stopping {cmd.target}')
                    live_agents[cmd.target].quit()
                    del live_agents[cmd.target]
                cmd = god.poll_command()

            current = live_agents.get(current_id)
            defn = agent_map.get(current_id)
            if not current or not defn:
                log.error(f'Agent "{current_id}" not available')
                if git_enabled and commit_hashes:
                    last = max(commit_hashes.keys())
                    log.orch(f'Rolling back to round {last}')
                    git.rollback(commit_hashes[last])
                break

            agent_call_history.append(current_id)
            log.orch(f'Round {round_num}: {defn.name}')
            log.agent(defn.name, '← prompt', message[:300] + ('...' if len(message) > 300 else ''))

            response = _send_with_retry(current, message, log)
            signal = parse(response)

            log.agent(defn.name, '→ response', signal.clean_response)
            data_collector.collect(workdir, current_id, defn.name, message, signal.clean_response, signal.kind)
            log.record(round_num, defn.name, signal.clean_response)

            if git_enabled:
                h = git.commit(round_num, defn.name)
                if h:
                    commit_hashes[round_num] = h
                    log.orch(f'📌 Checkpoint: {h[:8]}')

            try:
                next_id = signal.target if signal.kind == 'handoff' else current_id
                next_msg = ''
                if signal.kind == 'handoff':
                    next_msg = (
                        f"O agente {defn.name} completou sua parte e passou para você:\n\n"
                        f"---\n{signal.clean_response}\n---\n\n"
                        f"Contexto do handoff: {signal.summary}"
                    )
                state = SwarmState(
                    round_num=round_num, current_agent_id=next_id,
                    pending_message=next_msg, agent_ids=list(live_agents.keys()),
                    commit_hashes=commit_hashes, project_dir=workdir,
                )
                save_swarm(workdir, state, live_agents)
                log.orch(f'💾 State saved (round {round_num})')
            except Exception as e:
                log.error(f'Save failed: {e}')

            if god:
                recent = agent_call_history[-5:]
                loop_count = sum(1 for x in recent if x == current_id)
                summary = build_summary(
                    round_num, defn.name, signal.kind, signal.target,
                    list(live_agents.keys()), errors, loop_count,
                )
                god.submit_review(round_num, summary)

            if signal.kind != 'none':
                action, next_id, next_msg = _handle_signal(signal, current_id, defn, flow, log, agent_map, return_stack)
                if action == 'break': break
                message, current_id = next_msg, next_id
                continue

            # No signal — nudge
            nudged = False
            for _nudge in range(MAX_SIGNAL_NUDGES):
                log.orch(f'⚠ No signal from {defn.name}, nudging...')
                nudge_resp = _send_with_retry(current, NUDGE_MESSAGE, log)
                signal = parse(nudge_resp)
                log.agent(defn.name, '→ nudge response', signal.clean_response)
                log.record(round_num, defn.name, signal.clean_response)
                if signal.kind != 'none':
                    nudged = True
                    break
            if not nudged:
                log.orch(f'No signal from {defn.name} after nudge, treating as done')
                break
            action, next_id, next_msg = _handle_signal(signal, current_id, defn, flow, log, agent_map, return_stack)
            if action == 'break': break
            message, current_id = next_msg, next_id

        log.orch('Swarm complete!')

    except KeyboardInterrupt:
        log.error('Interrupted')
        if git_enabled:
            log.orch('Rolling back to initial state')
            git.rollback_to_initial()
    except Exception as e:
        log.error(str(e))
        if git_enabled and commit_hashes:
            prev = max(commit_hashes.keys()) - 1
            if prev in commit_hashes:
                log.orch(f'Error — rolling back to round {prev}')
                git.rollback(commit_hashes[prev])
        raise
    finally:
        if log.transcript:
            log.save_transcript(Path(workdir) / '.kiro-swarm')
        for a in live_agents.values():
            a.quit()
        if god:
            god.quit()
        log.orch('All agents shut down.')

    return log.transcript


if __name__ == '__main__':
    question = sys.argv[1] if len(sys.argv) > 1 else 'Como podemos melhorar esse projeto?'
    run_swarm(question)
