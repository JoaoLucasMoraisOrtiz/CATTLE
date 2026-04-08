"""SwarmSession — persistent agents, chat-style messaging, auto-save, auto-compact."""

import os, re, time, threading, json
import registry
from registry import AgentDef
from agent import Agent
from protocol import parse
from flow import Flow, load as load_flow
from checkpoint import GitCheckpoint
from swarm_state import save_swarm, SwarmState, save_agent_session, append_chat_message, load_chat_history, _project_dir
from config import PROTOCOL_INSTRUCTIONS, MAX_HANDOFF_ROUNDS, MIN_RESPONSE_LEN, MAX_RETRIES
import flow as flowmod

COMPACT_THRESHOLD = 70
CONTEXT_RE = re.compile(r'(\d+)%.*?!>')


class EventCallback:
    def on_orch(self, msg): pass
    def on_agent(self, name, event, text): pass
    def on_error(self, msg): pass
    def on_summary(self, text): pass
    def on_done(self): pass


class SwarmSession:
    def __init__(self, project_path, cb=None):
        self.project_path = os.path.abspath(os.path.expanduser(project_path))
        self.cb = cb or EventCallback()
        self.agents = {}
        self.agent_defs = {}
        self.git = GitCheckpoint(self.project_path)
        self.flow = Flow()
        self.round_num = 0
        self.alive = False
        self._lock = threading.Lock()
        self._abort = threading.Event()
        self._pending_messages = []
        self._opening = True

    def open(self):
        self.flow = load_flow()
        all_defs = registry.load()
        self.agent_defs = {a.id: a for a in all_defs}
        flow_ids = {n.agent_id for n in self.flow.nodes}
        self.git.init()
        self.cb.on_orch(f'Project: {self.project_path}')

        results = {}
        lock = threading.Lock()

        def safe_spawn(nid, defn):
            try:
                targets = self.flow.targets_for(nid)
                visible = [a for a in all_defs if a.id in targets]
                agent_list = '\n'.join(f'- {a.id}: {a.name} — {a.persona[:80]}...' for a in visible) if visible else '(nenhum — use @done)'
                persona = defn.persona + '\n\n' + PROTOCOL_INSTRUCTIONS.format(agent_list=agent_list)
                agent = Agent(defn.name, self.project_path, defn.model, defn.mcps or None)
                agent.on_chunk = lambda text, n=defn.name: self.cb.on_agent(n, '⏳ streaming', text)
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
        agents_copy = list(self.agents.items())
        for aid, agent in agents_copy:
            try:
                agent._pty.write('/compact\r')
                agent._read_until_prompt(timeout=30)
                save_agent_session(agent, aid, self.project_path)
            except Exception: pass
        self._save_state()
        for _, a in agents_copy: a.quit()
        self.agents.clear()
        self.alive = False
        self.cb.on_orch('Session closed')

    def abort(self):
        self._abort.set()
        self.cb.on_orch('⏹ Operação abortada')

    def restart_agent(self, agent_id):
        defn = self.agent_defs.get(agent_id)
        if not defn: self.cb.on_error(f'Agent {agent_id} not found'); return
        if agent_id in self.agents: self.agents[agent_id].quit()
        self.cb.on_orch(f'🔄 Restarting {defn.name}...')
        self._spawn_agent(agent_id, defn, list(self.agent_defs.values()))

    def send_to_swarm(self, message):
        if self._opening:
            self._pending_messages.append((message, None))
            self.cb.on_orch('⏳ Agents still loading — message queued')
            return
        if not self.alive: self.cb.on_error('Session not open'); return
        with self._lock:
            self._abort.clear()
            start_id = self.flow.start_agent()
            if not start_id or start_id not in self.agents:
                self.cb.on_error('No start agent in flow'); return
            self._chat('user', message)
            self._run_handoff_chain(start_id, message)
            self.cb.on_done()

    def send_to_agent(self, agent_id, message):
        if self._opening:
            self._pending_messages.append((message, agent_id))
            self.cb.on_orch('⏳ Agents still loading — message queued')
            return
        if not self.alive: self.cb.on_error('Session not open'); return
        with self._lock:
            self._abort.clear()
            match = next((aid for aid in self.agents if aid.lower() == agent_id.lower()), agent_id)
            agent = self.agents.get(match)
            defn = self.agent_defs.get(match)
            if not agent or not defn:
                self.cb.on_error(f'Agent {agent_id} not found'); self.cb.on_done(); return
            self.cb.on_agent(defn.name, '← direct', message[:300])
            self._chat('user', message, defn.name)
            try:
                response = self._send_with_retry(agent, message)
                agent = self.agents.get(match, agent)
            except Exception as e:
                self.cb.on_error(f'{defn.name}: {e}'); self.cb.on_done(); return
            signal = parse(response)
            self.cb.on_agent(defn.name, '→ response', signal.clean_response)
            self._chat('agent', signal.clean_response, defn.name)
            self._save_state()
            self._auto_compact(match, agent)
            # Follow handoff if requested
            if signal.kind == 'handoff' and signal.target in self.agents:
                self.cb.on_orch(f'→ {signal.target}: {signal.summary}')
                msg = f"[Handoff de {defn.name}] {signal.summary}"
                self._run_handoff_chain(signal.target, msg)
            self.cb.on_done()

    def _run_handoff_chain(self, start_id, message):
        current_id, msg = start_id, message
        for _ in range(MAX_HANDOFF_ROUNDS):
            if self._abort.is_set(): self.cb.on_orch('⏹ Abortado'); break
            self.round_num += 1
            agent = self.agents.get(current_id)
            defn = self.agent_defs.get(current_id)
            if not agent or not defn: self.cb.on_error(f'Agent {current_id} not available'); break
            self.cb.on_orch(f'Round {self.round_num}: {defn.name}')
            self.cb.on_agent(defn.name, '← prompt', msg[:300] + ('...' if len(msg) > 300 else ''))
            try:
                response = self._send_with_retry(agent, msg)
                agent = self.agents.get(current_id, agent)
            except Exception as e: self.cb.on_error(f'{defn.name}: {e}'); break
            if self._abort.is_set(): self.cb.on_orch('⏹ Abortado'); break
            signal = parse(response)
            self.cb.on_agent(defn.name, '→ response', signal.clean_response)
            self._chat('agent', signal.clean_response, defn.name)
            h = self.git.commit(self.round_num, defn.name)
            if h: self.cb.on_orch(f'📌 {h[:8]}')
            self._save_state()
            self._auto_compact(current_id, agent)
            if signal.kind == 'handoff':
                if signal.target not in self.agents:
                    self.cb.on_error(f'Agent {signal.target} not found'); break
                self.cb.on_orch(f'→ {signal.target}: {signal.summary}')
                msg = f"[Handoff de {defn.name}] {signal.summary}"
                current_id = signal.target
            elif signal.kind == 'done':
                self.cb.on_summary(f'{defn.name}: {signal.summary}')
                self._chat('summary', f'{defn.name}: {signal.summary}')
                break
            else:
                self.cb.on_summary(f'{defn.name} finalizou'); break

    def _spawn_agent(self, nid, defn, all_defs):
        targets = self.flow.targets_for(nid)
        visible = [a for a in all_defs if a.id in targets]
        agent_list = '\n'.join(f'- {a.id}: {a.name} — {a.persona[:80]}...' for a in visible) if visible else '(nenhum — use @done)'
        persona = defn.persona + '\n\n' + PROTOCOL_INSTRUCTIONS.format(agent_list=agent_list)
        agent = Agent(defn.name, self.project_path, defn.model, defn.mcps or None)
        agent.on_chunk = lambda text, n=defn.name: self.cb.on_agent(n, '⏳ streaming', text)
        agent.start()
        agent._persona = persona
        agent._persona_sent = False
        self.agents[nid] = agent
        self.cb.on_agent(defn.name, 'ready', '')

    def _chat(self, type, text, agent=''):
        append_chat_message(self.project_path, {'type': type, 'agent': agent, 'text': text, 'ts': time.time()})

    def _send_with_retry(self, agent, message):
        if hasattr(agent, '_persona') and not agent._persona_sent:
            message = f"[SISTEMA — SUA IDENTIDADE E REGRAS]\n{agent._persona}\n\n[TAREFA]\n{message}"
            agent._persona_sent = True
        if not agent._pty.is_alive():
            agent_id = next((k for k, v in self.agents.items() if v is agent), None)
            if agent_id:
                defn = self.agent_defs.get(agent_id)
                if defn:
                    self.cb.on_orch(f'🔄 {defn.name} was idle/dead — restarting...')
                    self._spawn_agent(agent_id, defn, list(self.agent_defs.values()))
                    agent = self.agents[agent_id]
                    if hasattr(agent, '_persona'):
                        message = f"[SISTEMA — SUA IDENTIDADE E REGRAS]\n{agent._persona}\n\n[TAREFA]\n{message}"
                        agent._persona_sent = True
        for attempt in range(MAX_RETRIES + 1):
            if self._abort.is_set(): raise RuntimeError('Aborted')
            try:
                resp = agent.send(message)
                if len(resp.strip()) >= MIN_RESPONSE_LEN: return resp
            except Exception as e:
                if attempt == MAX_RETRIES: raise
            time.sleep(2 ** attempt)
        return ''

    def _auto_compact(self, agent_id, agent):
        try:
            for entry in reversed(agent.log[-3:]):
                m = CONTEXT_RE.search(entry.get('data', ''))
                if m:
                    usage = int(m.group(1))
                    if usage >= COMPACT_THRESHOLD:
                        self.cb.on_orch(f'🗜 Auto-compact {self.agent_defs[agent_id].name} ({usage}%)')
                        agent._pty.write('/compact\r')
                        agent._read_until_prompt(timeout=30)
                    break
        except Exception: pass

    def _save_state(self):
        try:
            path = _project_dir(self.project_path) / 'swarm_state.json'
            path.write_text(json.dumps({
                'round_num': self.round_num,
                'current_agent_id': '',
                'pending_message': '',
                'agent_ids': list(self.agents.keys()),
                'commit_hashes': {},
                'project_dir': self.project_path,
            }, indent=2))
        except Exception: pass
