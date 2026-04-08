#!/usr/bin/env python3
"""Orchestrator — git checkpoints, async GOD, session persistence."""

import os
import sys
import time
from pathlib import Path

import registry
from registry import AgentDef
from agent import Agent
from logger import Logger
from protocol import parse
from flow import Flow, load as load_flow
from god import GodAgent, build_summary, GodCommand
from checkpoint import GitCheckpoint
from config import (
    PROTOCOL_INSTRUCTIONS, GOD_PERSONA,
    MAX_HANDOFF_ROUNDS, MIN_RESPONSE_LEN, MAX_RETRIES,
)
from swarm_state import SwarmState, save_swarm, load_swarm_state, resume_agent
import flow as flowmod


def _build_agent_list_for(agent_id: str, agents: list[AgentDef], flow: Flow) -> str:
    targets = flow.targets_for(agent_id)
    visible = [a for a in agents if a.id in targets]
    if not visible:
        return "(nenhum — você é o agente final, use @done)"
    return '\n'.join(f'- {a.id}: {a.name} — {a.persona[:80]}...' for a in visible)


def _init_agent(defn: AgentDef, agent_list: str, workdir: str, log: Logger) -> Agent:
    agent = Agent(defn.name, workdir, defn.model)
    agent.start()
    persona = (
        defn.persona + '\n\n' +
        PROTOCOL_INSTRUCTIONS.format(agent_list=agent_list) +
        '\n\nResponda apenas: "Entendido." Nada mais.'
    )
    agent.send(persona)
    log.agent(defn.name, 'ready', f'workdir: {workdir}')
    return agent


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


def run_swarm(question: str, workdir: str = '.', flow: Flow | None = None, log: Logger | None = None, resume: bool = False) -> list[dict]:
    if log is None:
        log = Logger()
    if flow is None:
        flow = load_flow()

    workdir = os.path.abspath(workdir)
    agent_defs = registry.load()
    agent_map = {a.id: a for a in agent_defs}

    # ── Resume from saved state? ──────────────────────────────
    saved = load_swarm_state(workdir) if resume else None
    if saved:
        log.orch(f'Resuming from round {saved.round_num}, agent: {saved.current_agent_id}')

    if not flow.nodes:
        raise ValueError('Flow has no nodes')

    start_id = saved.current_agent_id if saved else flow.start_agent()
    flow_ids = {n.agent_id for n in flow.nodes}
    log.orch(f'Workdir: {workdir}')
    log.orch(f'Flow: {len(flow.nodes)} nodes, {len(flow.edges)} edges, start: {start_id}')

    # Git checkpoint
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
    commit_hashes: dict[int, str] = {}  # round → commit hash

    try:
        # GOD (async watchdog)
        log.orch('Spawning GOD_AGENT...')
        god = GodAgent(workdir)
        god.start(GOD_PERSONA)
        log.agent('GOD', 'ready', 'Watchdog async')

        # Spawn flow agents
        for nid in flow_ids:
            defn = agent_map.get(nid)
            if not defn:
                continue
            if saved and nid in saved.agent_ids:
                log.orch(f'Resuming {defn.name}...')
                live_agents[nid] = resume_agent(nid, defn.name, workdir, defn.model)
                log.agent(defn.name, 'resumed', '')
            else:
                agent_list = _build_agent_list_for(nid, agent_defs, flow)
                log.orch(f'Spawning {defn.name}...')
                live_agents[nid] = _init_agent(defn, agent_list, workdir, log)

        current_id = start_id
        message = saved.pending_message if saved and saved.pending_message else question
        round_num = saved.round_num if saved else 0
        commit_hashes = saved.commit_hashes if saved else {}

        while round_num < MAX_HANDOFF_ROUNDS:
            round_num += 1

            # ── GOD commands (non-blocking) ───────────────────────
            cmd = god.poll_command() if god else None
            while cmd:
                log.agent('GOD', '→ action', f'@{cmd.action}({cmd.target}): {cmd.payload[:60]}' if cmd.payload else f'@{cmd.action}({cmd.target})')

                if cmd.action == 'restart' and cmd.target in live_agents:
                    log.orch(f'👁 GOD: restarting {cmd.target}')
                    live_agents[cmd.target].quit()
                    defn = agent_map[cmd.target]
                    agent_list = _build_agent_list_for(cmd.target, agent_defs, flow)
                    live_agents[cmd.target] = _init_agent(defn, agent_list, workdir, log)

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

            # ── Run the round ─────────────────────────────────────
            current = live_agents.get(current_id)
            defn = agent_map.get(current_id)
            if not current or not defn:
                log.error(f'Agent "{current_id}" not available')
                # Rollback last commit if agent was killed
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
            log.record(round_num, defn.name, signal.clean_response)

            # ── Git checkpoint ────────────────────────────────────
            if git_enabled:
                h = git.commit(round_num, defn.name)
                if h:
                    commit_hashes[round_num] = h
                    log.orch(f'📌 Checkpoint: {h[:8]}')

            # ── Save swarm state ──────────────────────────────────
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
                    round_num=round_num,
                    current_agent_id=next_id,
                    pending_message=next_msg,
                    agent_ids=list(live_agents.keys()),
                    commit_hashes=commit_hashes,
                    project_dir=workdir,
                )
                save_swarm(workdir, state, live_agents)
                log.orch(f'💾 State saved (round {round_num})')
            except Exception as e:
                log.error(f'Save failed: {e}')

            # ── Submit to GOD (non-blocking) ──────────────────────
            if god:
                # Count consecutive calls to detect loops
                recent = agent_call_history[-5:]
                loop_count = sum(1 for x in recent if x == current_id)
                summary = build_summary(
                    round_num, defn.name, signal.kind, signal.target,
                    list(live_agents.keys()), errors, loop_count,
                )
                god.submit_review(round_num, summary)

            # ── Route ─────────────────────────────────────────────
            if signal.kind == 'handoff':
                allowed = flow.targets_for(current_id)
                if signal.target not in allowed:
                    log.error(f'Handoff to "{signal.target}" blocked by flow')
                    break
                log.orch(f'Handoff → {signal.target}: {signal.summary}')
                message = (
                    f"O agente {defn.name} completou sua parte e passou para você:\n\n"
                    f"---\n{signal.clean_response}\n---\n\n"
                    f"Contexto do handoff: {signal.summary}"
                )
                current_id = signal.target

            elif signal.kind == 'done':
                log.orch(f'Done! {defn.name}: {signal.summary}')
                break
            else:
                log.orch(f'No signal from {defn.name}, treating as done')
                break

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
