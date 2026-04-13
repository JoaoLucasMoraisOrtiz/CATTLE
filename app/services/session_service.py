"""SwarmSession — persistent agents, chat-style messaging, auto-save, auto-compact."""

import hashlib
import os
import re
import shutil
import time
import threading
import json

from app.models.agent import AgentDef
from app.models.flow import Flow, Node
from app.core.agent import Agent
from app.core.protocol import parse
from app.core.checkpoint import GitCheckpoint
from app.core.swarm_state import save_swarm, SwarmState, save_agent_session, append_chat_message, load_chat_history, project_dir
from app.config import PROTOCOL_INSTRUCTIONS, MAX_HANDOFF_ROUNDS, MIN_RESPONSE_LEN, MAX_RETRIES, MAX_SIGNAL_NUDGES, NUDGE_MESSAGE
from app.services import registry, flow_service, header_service, data_collector
from app.services.agent_helpers import resolve_header_ids, compose_persona, build_agent_list_for
from app.services.cost_service import CostTracker

COMPACT_THRESHOLD = 70
CONTEXT_RE = re.compile(r'(\d+)%.*?!>')


class EventCallback:
    def on_orch(self, msg): pass
    def on_agent(self, name, event, text): pass
    def on_error(self, msg): pass
    def on_summary(self, text): pass
    def on_done(self): pass
    def on_cost(self, data): pass


class SwarmSession:
    def __init__(self, project_path, cb=None, flow_id=None):
        self.project_path = os.path.abspath(os.path.expanduser(project_path))
        self.cb = cb or EventCallback()
        self.flow_id = flow_id
        self.agents = {}
        self._lock = threading.Lock()
        self.agent_defs = {}
        self.git = GitCheckpoint(self.project_path)
        self.flow = Flow()
        self._flow_def = None
        self.round_num = 0
        self.alive = False
        self._busy = set()
        self._agent_queues = {}
        self._abort = threading.Event()
        self._pending_messages = []
        self._opening = True
        self._compacting = False
        self.cost_tracker = CostTracker()

    def open(self):
        fd = flow_service.get(self.flow_id) if self.flow_id else None
        self._flow_def = fd
        self.flow = fd.flow if fd else flow_service.load()
        all_defs = registry.load()
        self.agent_defs = {a.id: a for a in all_defs}
        flow_ids = {n.agent_id for n in self.flow.nodes}
        self.git.init()
        self.cb.on_orch(f'Project: {self.project_path}')
        header_service.ensure_defaults()

        results = {}
        lock = threading.Lock()

        def safe_spawn(nid, defn):
            try:
                targets = self.flow.targets_for(nid)
                visible = [a for a in all_defs if a.id in targets]
                agent_list = '\n'.join(f'- {a.id}: {a.name} — {a.persona[:80]}...' for a in visible) if visible else '(nenhum — use @done)'
                persona = self._compose_persona(nid, defn, agent_list)
                agent = Agent(defn.name, self.project_path, defn.model, defn.mcps or None, defn.cli_type)
                agent.on_chunk = lambda text, replace=False, n=defn.name: self.cb.on_agent(n, '⏳ streaming-replace' if replace else '⏳ streaming', text)
                agent.start()
                agent._persona = persona
                agent._persona_sent = False
                with lock:
                    results[nid] = agent
                self.cb.on_agent(defn.name, 'ready', '')
            except Exception as e:
                self.cb.on_error(f'Failed to spawn {defn.name}: {e}')

        threads = []
        for nid in flow_ids:
            defn = self.agent_defs.get(nid)
            if not defn: continue
            t = threading.Thread(target=safe_spawn, args=(nid, defn))
            t.start()
            threads.append(t)
        for t in threads:
            t.join()

        with self._lock:
            self.agents = results
        self.alive = True
        self._opening = False
        self.cb.on_orch(f'{len(self.agents)} agents ready')

        for text, agent_id in self._pending_messages:
            if agent_id: self.send_to_agent(agent_id, text)
            else: self.send_to_swarm(text)
        self._pending_messages.clear()

    def close(self):
        self._abort.set()
        with self._lock:
            agents_copy = list(self.agents.items())
        for aid, agent in agents_copy:
            try:
                (agent._pty.write(agent._driver.compact_cmd + '\r') if agent._driver.compact_cmd else None)
                agent._read_until_prompt(timeout=30)
                save_agent_session(agent, aid, self.project_path)
            except Exception: pass
        self._save_state()
        for _, a in agents_copy: a.quit()
        # E5: cleanup env-manager state dir
        env_dir = f"/tmp/kiro-env-{hashlib.md5(self.project_path.encode()).hexdigest()[:12]}"
        shutil.rmtree(env_dir, ignore_errors=True)
        with self._lock:
            self.agents.clear()
        self.alive = False
        self.cb.on_orch('Session closed')

    def abort(self):
        self._abort.set()
        with self._lock:
            agents_copy = list(self.agents.values())
        for agent in agents_copy:
            try: agent._pty.interrupt()
            except Exception: pass
        self.cb.on_orch('⏹ Operação abortada')

    def interrupt_agent(self, agent_id):
        with self._lock:
            match = next((aid for aid in self.agents if aid.lower() == agent_id.lower()), None)
            agent = self.agents.get(match) if match else None
        if agent:
            agent._pty.interrupt()
            name = self.agent_defs.get(match, match).name
            self.cb.on_orch(f'⏹ {name} interrompido')

    def restart_agent(self, agent_id):
        # Reload from registry to pick up cli_type changes
        fresh = registry.get(agent_id)
        if fresh:
            self.agent_defs[agent_id] = fresh
        defn = self.agent_defs.get(agent_id)
        if not defn: self.cb.on_error(f'Agent {agent_id} not found'); return
        with self._lock:
            old = self.agents.get(agent_id)
        if old: old.quit()
        self.cb.on_orch(f'🔄 Restarting {defn.name} ({defn.cli_type})...')
        self._spawn_agent(agent_id, defn, list(self.agent_defs.values()))

    def send_to_swarm(self, message):
        if self._opening:
            self._pending_messages.append((message, None))
            self.cb.on_orch('⏳ Agents still loading — message queued')
            return
        if not self.alive: self.cb.on_error('Session not open'); return
        if self._compacting: self.cb.on_error('⏳ Aguarde — compactando contexto dos agentes...'); return
        self._abort.clear()
        start_id = self.flow.start_agent()
        with self._lock:
            has_start = start_id and start_id in self.agents
        if not has_start:
            self.cb.on_error('No start agent in flow'); return
        self._chat('user', message)
        self._run_handoff_chain(start_id, message)
        self._compact_all()
        self.cb.on_done()

    def send_to_agent(self, agent_id, message):
        if self._opening:
            self._pending_messages.append((message, agent_id))
            self.cb.on_orch('⏳ Agents still loading — message queued')
            return
        if not self.alive: self.cb.on_error('Session not open'); return
        if self._compacting: self.cb.on_error('⏳ Aguarde — compactando contexto dos agentes...'); return
        with self._lock:
            match = next((aid for aid in self.agents if aid.lower() == agent_id.lower()), agent_id)
        if match in self._busy:
            self.cb.on_orch(f'⏳ {self.agent_defs.get(match, agent_id).name} ocupado — mensagem na fila')
            self._agent_queues.setdefault(match, []).append(message)
            return
        self._abort.clear()
        threading.Thread(target=self._do_send_to_agent, args=(match, message), daemon=True).start()

    def _do_send_to_agent(self, match, message):
        self._busy.add(match)
        try:
            with self._lock:
                agent = self.agents.get(match)
            defn = self.agent_defs.get(match)
            if not agent or not defn:
                self.cb.on_error(f'Agent {match} not found'); self.cb.on_done(); return
            self.cb.on_agent(defn.name, '← direct', message[:300])
            self._chat('user', message, defn.name)
            try:
                response = self._send_with_retry(agent, message)
                with self._lock:
                    agent = self.agents.get(match, agent)
            except Exception as e:
                self.cb.on_error(f'{defn.name}: {e}'); self.cb.on_done(); return
            signal = parse(response)
            data_collector.collect(self.project_path, match, defn.name, message, signal.clean_response, signal.kind, flow_id=self.flow_id or '')
            self.cb.on_agent(defn.name, '→ response', signal.clean_response)
            self._chat('agent', signal.clean_response, defn.name)
            self._record_cost(match, defn.name, message, signal.clean_response)
            self._save_state()
            self._auto_compact(match, agent)
            with self._lock:
                target_exists = signal.kind == 'handoff' and signal.target in self.agents
            if target_exists:
                self.cb.on_orch(f'→ {signal.target}: {signal.summary}')
                msg = self._handoff_msg(defn.name, signal)
                self._run_handoff_chain(signal.target, msg)
            self.cb.on_done()
        finally:
            self._busy.discard(match)
            self._drain_queue(match)

    def _drain_queue(self, agent_id):
        q = self._agent_queues.get(agent_id, [])
        if q:
            msg = q.pop(0)
            self.cb.on_orch(f'📨 Processando mensagem da fila para {self.agent_defs.get(agent_id, agent_id).name}')
            self._do_send_to_agent(agent_id, msg)

    def _handle_signal(self, signal, current_id, defn, return_stack):
        """Returns (action, next_id, next_msg). action: 'continue' or 'break'."""
        if signal.kind == 'handoff':
            allowed = self.flow.targets_for(current_id)
            if signal.target not in allowed:
                self.cb.on_error(f'Handoff to {signal.target} blocked (no edge from {defn.name})')
                return ('break', '', '')
            if self.flow.edge_returns(current_id, signal.target):
                return_stack.append(current_id)
                self.cb.on_orch(f'↩ {signal.target} (retorno obrigatório para {defn.name})')
            else:
                self.cb.on_orch(f'→ {signal.target}: {signal.summary}')
            return ('continue', signal.target, self._handoff_msg(defn.name, signal))
        elif signal.kind == 'done':
            if return_stack:
                sender_id = return_stack.pop()
                sender_name = self.agent_defs.get(sender_id, defn).name
                self.cb.on_orch(f'↩ {defn.name} finalizou, retornando para {sender_name}')
                return ('continue', sender_id, f"[Retorno de {defn.name}] {signal.summary}")
            self.cb.on_summary(f'{defn.name}: {signal.summary}')
            self._chat('summary', f'{defn.name}: {signal.summary}')
            return ('break', '', '')
        else:
            if return_stack:
                sender_id = return_stack.pop()
                sender_name = self.agent_defs.get(sender_id, defn).name
                self.cb.on_orch(f'↩ Retornando para {sender_name}')
                return ('continue', sender_id, f"[Retorno de {defn.name}] {signal.clean_response[:500]}")
            self.cb.on_summary(f'{defn.name} finalizou')
            return ('break', '', '')

    def _run_handoff_chain(self, start_id, message):
        current_id, msg = start_id, message
        return_stack = []
        used_agents = set()
        for _ in range(MAX_HANDOFF_ROUNDS):
            if self._abort.is_set(): self.cb.on_orch('⏹ Abortado'); break
            if current_id in self._busy:
                self.cb.on_error(f'Agent {current_id} is busy — chain paused')
                break
            self._busy.add(current_id)
            used_agents.add(current_id)
            self.round_num += 1
            with self._lock:
                agent = self.agents.get(current_id)
            defn = self.agent_defs.get(current_id)
            if not agent or not defn: self.cb.on_error(f'Agent {current_id} not available'); break
            self.cb.on_orch(f'Round {self.round_num}: {defn.name}')
            self.cb.on_agent(defn.name, '← prompt', msg[:300] + ('...' if len(msg) > 300 else ''))
            try:
                response = self._send_with_retry(agent, msg)
                with self._lock:
                    agent = self.agents.get(current_id, agent)
            except Exception as e: self.cb.on_error(f'{defn.name}: {e}'); break
            if self._abort.is_set(): self.cb.on_orch('⏹ Abortado'); break
            signal = parse(response)
            data_collector.collect(self.project_path, current_id, defn.name, msg, signal.clean_response, signal.kind, flow_id=self.flow_id or '', round_num=self.round_num)
            self.cb.on_agent(defn.name, '→ response', signal.clean_response)
            self._chat('agent', signal.clean_response, defn.name)
            self._record_cost(current_id, defn.name, msg, signal.clean_response)
            h = self.git.commit(self.round_num, defn.name)
            if h: self.cb.on_orch(f'📌 {h[:8]}')
            self._save_state()
            self._auto_compact(current_id, agent)
            if return_stack and return_stack[-1] != current_id:
                sender_id = return_stack.pop()
                sender_name = self.agent_defs.get(sender_id, defn).name
                if signal.kind == 'handoff' and signal.target != sender_id:
                    self.cb.on_orch(f'⚠️ {defn.name} quis enviar para {signal.target}, mas retorno forçado para {sender_name}')
                msg = f"[Retorno de {defn.name}] {signal.summary or signal.clean_response[:500]}"
                current_id = sender_id
                continue
            if signal.kind != 'none':
                action, next_id, next_msg = self._handle_signal(signal, current_id, defn, return_stack)
                if action == 'break': break
                current_id, msg = next_id, next_msg
                continue
            # No signal — nudge
            nudged = False
            for _nudge in range(MAX_SIGNAL_NUDGES):
                self.cb.on_orch(f'⚠ No signal from {defn.name}, nudging...')
                try:
                    nudge_resp = self._send_with_retry(agent, NUDGE_MESSAGE)
                    with self._lock:
                        agent = self.agents.get(current_id, agent)
                except Exception as e:
                    self.cb.on_error(f'{defn.name} nudge failed: {e}'); break
                signal = parse(nudge_resp)
                self.cb.on_agent(defn.name, '→ nudge response', signal.clean_response)
                self._chat('agent', signal.clean_response, defn.name)
                if signal.kind != 'none':
                    nudged = True
                    break
            action, next_id, next_msg = self._handle_signal(signal, current_id, defn, return_stack)
            if action == 'break': break
            current_id, msg = next_id, next_msg
        self._busy -= used_agents

    def _spawn_agent(self, nid, defn, all_defs):
        targets = self.flow.targets_for(nid)
        visible = [a for a in all_defs if a.id in targets]
        agent_list = '\n'.join(f'- {a.id}: {a.name} — {a.persona[:80]}...' for a in visible) if visible else '(nenhum — use @done)'
        persona = self._compose_persona(nid, defn, agent_list)
        agent = Agent(defn.name, self.project_path, defn.model, defn.mcps or None, defn.cli_type)
        agent.on_chunk = lambda text, replace=False, n=defn.name: self.cb.on_agent(n, '⏳ streaming-replace' if replace else '⏳ streaming', text)
        agent.start()
        agent._persona = persona
        agent._persona_sent = False
        with self._lock:
            self.agents[nid] = agent
        self.cb.on_agent(defn.name, 'ready', '')

    def _resolve_header_ids(self, node_id: str) -> list[str]:
        return resolve_header_ids(node_id, self.flow, self._flow_def)

    def _compose_persona(self, nid, defn, agent_list):
        hids = self._resolve_header_ids(nid)
        return compose_persona(defn, hids, agent_list)

    def _handoff_msg(self, sender_name, signal):
        ctx = signal.clean_response
        if len(ctx) > 1500:
            ctx = '...\n' + ctx[-1500:]
        h = header_service.get_default('handoff')
        if h:
            return h.content.format_map({
                'agent_name': sender_name,
                'task': signal.summary,
                'handoff_context': ctx,
            })
        return f"[Handoff de {sender_name}]\n{signal.summary}\n\n{ctx}"

    def _chat(self, type, text, agent=''):
        append_chat_message(self.project_path, {'type': type, 'agent': agent, 'text': text, 'ts': time.time()})

    def _record_cost(self, agent_id, agent_name, input_text, output_text):
        self.cost_tracker.record(agent_id, agent_name, input_text, output_text, self.round_num)
        self.cb.on_cost(self.cost_tracker.get_summary())

    def _wrap_first_message(self, agent, message):
        if not (hasattr(agent, '_persona') and not agent._persona_sent):
            return message
        wrapper = header_service.get_default('wrapper')
        if wrapper:
            message = wrapper.content.format_map({
                'agent_persona': agent._persona, 'task': message,
                'agent_name': agent.name, 'agent_list': '',
            })
        else:
            message = f"[SISTEMA — SUA IDENTIDADE E REGRAS]\n{agent._persona}\n\n[TAREFA]\n{message}"
        agent._persona_sent = True
        return message

    def _send_with_retry(self, agent, message):
        if not agent._pty.is_alive():
            with self._lock:
                agent_id = next((k for k, v in self.agents.items() if v is agent), None)
            if agent_id:
                defn = self.agent_defs.get(agent_id)
                if defn:
                    self.cb.on_orch(f'🔄 {defn.name} was idle/dead — restarting...')
                    self._spawn_agent(agent_id, defn, list(self.agent_defs.values()))
                    with self._lock:
                        agent = self.agents[agent_id]
        message = self._wrap_first_message(agent, message)
        for attempt in range(MAX_RETRIES + 1):
            if self._abort.is_set(): raise RuntimeError('Aborted')
            try:
                resp = agent.send(message)
                if len(resp.strip()) >= MIN_RESPONSE_LEN: return resp
            except Exception as e:
                if attempt == MAX_RETRIES: raise
            time.sleep(2 ** attempt)
        return ''

    def _compact_all(self):
        self._compacting = True
        self.cb.on_orch('🗜 Compactando contexto de todos os agentes...')
        with self._lock:
            agents_copy = list(self.agents.items())
        def do_compact(aid, agent):
            try:
                name = self.agent_defs.get(aid, agent).name
                self.cb.on_agent(name, '⏳ streaming', '🗜 Compactando...\n')
                (agent._pty.write(agent._driver.compact_cmd + '\r') if agent._driver.compact_cmd else None)
                agent._read_until_prompt(timeout=60)
                agent._persona_sent = False
                self.cb.on_agent(name, 'ready', '')
            except Exception:
                pass
        threads = [threading.Thread(target=do_compact, args=(aid, a)) for aid, a in agents_copy]
        for t in threads: t.start()
        for t in threads: t.join()
        self._compacting = False
        self.cb.on_orch('✓ Contexto compactado')

    def _auto_compact(self, agent_id, agent):
        try:
            for entry in reversed(agent.log[-3:]):
                m = CONTEXT_RE.search(entry.get('data', ''))
                if m:
                    usage = int(m.group(1))
                    if usage >= COMPACT_THRESHOLD:
                        self.cb.on_orch(f'🗜 Auto-compact {self.agent_defs[agent_id].name} ({usage}%)')
                        (agent._pty.write(agent._driver.compact_cmd + '\r') if agent._driver.compact_cmd else None)
                        agent._read_until_prompt(timeout=30)
                        agent._persona_sent = False
                    break
        except Exception: pass

    def _save_state(self):
        try:
            with self._lock:
                agent_ids = list(self.agents.keys())
            path = project_dir(self.project_path) / 'swarm_state.json'
            path.write_text(json.dumps({
                'round_num': self.round_num,
                'current_agent_id': '',
                'pending_message': '',
                'agent_ids': agent_ids,
                'commit_hashes': {},
                'project_dir': self.project_path,
            }, indent=2))
        except Exception: pass
