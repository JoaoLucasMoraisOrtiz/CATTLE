"""PTY lifecycle — spawn kiro-cli, raw read/write, quit. Nothing else."""

import json
import os
import shutil
import tempfile
import time
import pexpect

from config import HOME_ALLOWLIST


def make_clean_env(mcps: dict | None = None) -> tuple[dict, str]:
    """Create temp HOME with allowlisted symlinks + agent-specific MCP config."""
    real_home = os.path.expanduser('~')
    tmp = tempfile.mkdtemp(prefix='kiro_agent_')
    for item in os.listdir(real_home):
        if item in HOME_ALLOWLIST:
            src = os.path.join(real_home, item)
            if os.path.exists(src):
                os.symlink(src, os.path.join(tmp, item))
    # Copy .kiro with agent-specific MCPs
    real_kiro = os.path.join(real_home, '.kiro')
    if os.path.exists(real_kiro):
        shutil.copytree(real_kiro, os.path.join(tmp, '.kiro'))
        mcp_path = os.path.join(tmp, '.kiro', 'settings', 'mcp.json')
        os.makedirs(os.path.dirname(mcp_path), exist_ok=True)
        with open(mcp_path, 'w') as f:
            f.write(json.dumps({"mcpServers": mcps or {}}))
    env = os.environ.copy()
    env['HOME'] = tmp
    return env, tmp


class PtyProcess:
    """Manages a single kiro-cli PTY process."""

    def __init__(self, workdir: str, model: str | None = None, mcps: dict | None = None):
        self.workdir = workdir
        self.model = model
        self.mcps = mcps
        self.proc: pexpect.spawn | None = None
        self._tmp_home: str | None = None

    def spawn(self) -> None:
        env, self._tmp_home = make_clean_env(self.mcps)
        cmd = 'kiro-cli chat --wrap never -a'
        if self.model:
            cmd += f' --model {self.model}'
        self.proc = pexpect.spawn(
            cmd, cwd=self.workdir, encoding='utf-8',
            timeout=180, maxread=65536, env=env,
        )

    def write(self, text: str) -> None:
        assert self.proc and self.proc.isalive()
        self.proc.send(text + '\r')

    def read_chunk(self, timeout: float = 5) -> str | None:
        try:
            return self.proc.read_nonblocking(size=4096, timeout=timeout)
        except (pexpect.TIMEOUT, pexpect.EOF):
            return None

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.isalive()

    def interrupt(self) -> None:
        """Send Ctrl+C (SIGINT) to interrupt current generation."""
        if self.proc and self.proc.isalive():
            self.proc.sendintr()

    def kill(self) -> None:
        if self.proc and self.proc.isalive():
            try:
                self.proc.send('/quit\r')
                time.sleep(0.5)
            except Exception:
                pass
            try:
                self.proc.terminate(force=True)
            except Exception:
                pass
        self.proc = None
        if self._tmp_home:
            shutil.rmtree(self._tmp_home, ignore_errors=True)
            self._tmp_home = None
