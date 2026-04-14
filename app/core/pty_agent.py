"""PTY lifecycle — spawn CLI agent (kiro/gemini), raw read/write, quit."""

import hashlib
import json
import os
import shutil
import tempfile
import time
import pexpect

from app.config import HOME_ALLOWLIST, HOME_COPYLIST, ENV_MCP_AUTO_INJECT, ENV_MCP_TIMEOUT
from app.core.cli_driver import CliDriver, get_driver, KIRO_DRIVER

try:
    import pyte
except ImportError:
    pyte = None


_home_cache = {}  # workdir -> tmp home path

def make_clean_env(mcps: dict | None = None, workdir: str | None = None, driver: CliDriver | None = None) -> tuple[dict, str]:
    real_home = os.path.expanduser('~')
    cache_key = os.path.abspath(workdir) if workdir else None

    if cache_key and cache_key in _home_cache and os.path.isdir(_home_cache[cache_key]):
        tmp = _home_cache[cache_key]
    else:
        tmp = tempfile.mkdtemp(prefix='kiro_agent_')
        for item in os.listdir(real_home):
            if item in HOME_ALLOWLIST:
                src = os.path.join(real_home, item)
                if os.path.exists(src):
                    os.symlink(src, os.path.join(tmp, item))
            elif item in HOME_COPYLIST:
                src = os.path.join(real_home, item)
                if os.path.isdir(src):
                    shutil.copytree(src, os.path.join(tmp, item), symlinks=True)
        if cache_key:
            _home_cache[cache_key] = tmp
    merged = dict(mcps or {})
    if workdir and ENV_MCP_AUTO_INJECT:
        state_dir = f"/tmp/kiro-env-{hashlib.md5(workdir.encode()).hexdigest()[:12]}"
        script = os.path.abspath(os.path.join(os.path.dirname(__file__), "env_mcp_server.py"))
        merged["env-manager"] = {
            "command": "python3",
            "args": [script, "--state-dir", state_dir],
            "timeout": ENV_MCP_TIMEOUT,
        }
    # Driver-specific: write MCP config
    d = driver or KIRO_DRIVER
    if d.name == 'kiro':
        real_kiro = os.path.join(real_home, '.kiro')
        if os.path.exists(real_kiro):
            shutil.copytree(real_kiro, os.path.join(tmp, '.kiro'))
        
        mcp_path = os.path.join(tmp, '.kiro', 'settings', 'mcp.json')
        os.makedirs(os.path.dirname(mcp_path), exist_ok=True)
        with open(mcp_path, 'w') as f:
            f.write(json.dumps({"mcpServers": merged}))
    
    elif d.name == 'gemini':
        real_gemini = os.path.join(real_home, '.gemini')
        if os.path.exists(real_gemini):
            shutil.copytree(real_gemini, os.path.join(tmp, '.gemini'))
        
        settings_path = os.path.join(tmp, '.gemini', 'settings.json')
        os.makedirs(os.path.dirname(settings_path), exist_ok=True)
        
        settings = {}
        if os.path.exists(settings_path):
            try:
                with open(settings_path, 'r') as f:
                    settings = json.load(f)
            except Exception:
                pass
        
        # Add trust=True to automatically injected MCPs for zero friction
        for name, config in merged.items():
            if isinstance(config, dict):
                config['trust'] = True
        
        settings['mcpServers'] = merged
        # Ensure mcp.allowed contains our servers
        mcp_config = settings.get('mcp', {})
        allowed = set(mcp_config.get('allowed', []))
        allowed.update(merged.keys())
        mcp_config['allowed'] = list(allowed)
        settings['mcp'] = mcp_config

        with open(settings_path, 'w') as f:
            f.write(json.dumps(settings, indent=2))
    env = os.environ.copy()
    env['HOME'] = tmp
    return env, tmp


class PtyProcess:
    def __init__(self, workdir: str, model: str | None = None, mcps: dict | None = None, cli_type: str = 'kiro'):
        self.workdir = workdir
        self.model = model
        self.mcps = mcps
        self.driver = get_driver(cli_type)
        self.proc: pexpect.spawn | None = None
        self._tmp_home: str | None = None

    def spawn(self) -> None:
        env, self._tmp_home = make_clean_env(self.mcps, self.workdir, self.driver)
        cmd = self.driver.spawn_cmd
        if self.model and self.driver.model_flag:
            cmd += f' {self.driver.model_flag} {self.model}'
        self.proc = pexpect.spawn(
            cmd, cwd=self.workdir, encoding='utf-8',
            timeout=180, maxread=65536, env=env,
        )
        # For TUI-based CLIs, use pyte virtual terminal
        if self.driver.tui_chrome_re and pyte:
            self._screen = pyte.Screen(200, 500)
            self._stream = pyte.Stream(self._screen)
        else:
            self._screen = None
            self._stream = None

    def write(self, text: str) -> None:
        assert self.proc and self.proc.isalive()
        # For TUI CLIs: '!' triggers shell mode in Gemini
        if self._screen is not None:
            text = text.replace('!', '.')
        self.proc.send(text)
        import time; time.sleep(0.3)
        self.proc.send(self.driver.submit_suffix)

    def read_chunk(self, timeout: float = 5) -> str | None:
        try:
            data = self.proc.read_nonblocking(size=4096, timeout=timeout)
            if self._stream and data:
                try:
                    self._stream.feed(data)
                except Exception:
                    pass
            return data
        except pexpect.TIMEOUT:
            return None
        except pexpect.EOF:
            raise RuntimeError('Process died')

    def screen_contains(self, text: str) -> bool:
        """Check if the virtual terminal screen contains text (for TUI CLIs)."""
        if not self._screen:
            return False
        return any(text in line for line in self._screen.display)

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.isalive()

    def interrupt(self) -> None:
        if self.proc and self.proc.isalive():
            self.proc.sendintr()

    def kill(self) -> None:
        if self.proc and self.proc.isalive():
            if self.driver.quit_cmd:
                try:
                    self.proc.send(self.driver.quit_cmd + '\r')
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
