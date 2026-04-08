"""GOD_AGENT — async technical watchdog (not quality judge)."""

import re
import queue
import threading
from dataclasses import dataclass
from agent import Agent

@dataclass
class GodCommand:
    action: str      # continue, restart, compact, stop
    target: str
    payload: str
    round_num: int = 0

_CMD_RE = re.compile(
    r'@(continue|restart|compact|stop)'
    r'(?:\((\w+)\))?'
    r'(?:\s*:\s*(.+))?',
    re.DOTALL
)

def parse_command(text: str) -> GodCommand:
    tail = '\n'.join(text.strip().split('\n')[-10:])
    m = _CMD_RE.search(tail)
    if not m:
        return GodCommand('continue', '', '')
    return GodCommand(m.group(1), m.group(2) or '', (m.group(3) or '').strip())


def build_summary(round_num, agent_name, signal_kind, signal_target, active_agents, errors, loop_count):
    lines = [f"Round {round_num} | {agent_name} | signal={signal_kind}"]
    if signal_target:
        lines[0] += f" → {signal_target}"
    lines.append(f"Agents: {', '.join(active_agents)}")
    if loop_count >= 3:
        lines.append(f"⚠ LOOP: {agent_name} chamado {loop_count}x seguidas")
    if errors:
        lines.append(f"Errors: {'; '.join(errors[-3:])}")
    lines.append("Status?")
    return '\n'.join(lines)


class GodAgent:
    """Async technical watchdog. Reviews in background, commands via queue."""

    def __init__(self, workdir: str, model: str | None = None):
        self._agent: Agent | None = None
        self._workdir = workdir
        self._model = model
        self.active = False
        self.commands: queue.Queue[GodCommand] = queue.Queue()
        self._pending: queue.Queue[tuple[int, str]] = queue.Queue()
        self._thread: threading.Thread | None = None

    def start(self, persona: str) -> None:
        self._agent = Agent('GOD', self._workdir, self._model)
        self._agent.start()
        self._agent.send(persona + '\n\nResponda apenas: "Entendido."')
        self.active = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def submit_review(self, round_num: int, summary: str) -> None:
        if self.active:
            self._pending.put((round_num, summary))

    def poll_command(self) -> GodCommand | None:
        try:
            return self.commands.get_nowait()
        except queue.Empty:
            return None

    def _loop(self) -> None:
        while self.active:
            try:
                rn, summary = self._pending.get(timeout=1)
            except queue.Empty:
                continue
            try:
                resp = self._agent.send(summary)
                cmd = parse_command(resp)
                cmd.round_num = rn
                if cmd.action != 'continue':
                    self.commands.put(cmd)
            except Exception:
                pass

    def quit(self) -> None:
        self.active = False
        if self._agent:
            self._agent.quit()
