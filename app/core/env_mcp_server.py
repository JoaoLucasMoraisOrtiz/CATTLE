"""Environment Manager MCP — background process management for kiro-cli agents."""

import argparse
import atexit
import json
import os
import signal
import subprocess
import threading
import time
from collections import deque

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("env-manager")

BUFFER_LINES = int(os.environ.get("ENV_MCP_BUFFER_LINES", "500"))


class ProcessManager:
    def __init__(self, state_dir: str):
        self.state_dir = state_dir
        os.makedirs(state_dir, exist_ok=True)
        self._procs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._reconcile()

    # ── persistence ──────────────────────────────────────────────

    @property
    def _json_path(self):
        return os.path.join(self.state_dir, "processes.json")

    def _save(self):
        data = {}
        for name, info in self._procs.items():
            data[name] = {"pid": info["proc"].pid, "command": info["command"], "start_time": info["start_time"]}
        with open(self._json_path, "w") as f:
            json.dump(data, f)

    def _reconcile(self):
        if not os.path.exists(self._json_path):
            return
        try:
            with open(self._json_path) as f:
                saved = json.load(f)
        except Exception:
            return
        for name, info in saved.items():
            pid = info["pid"]
            try:
                os.kill(pid, 0)
                # Process alive but we lost the Popen handle — mark as zombie
                with self._lock:
                    self._procs[name] = {
                        "proc": _ZombieProc(pid),
                        "buffer": deque(["[reconnected — output unavailable]"], maxlen=BUFFER_LINES),
                        "command": info["command"],
                        "start_time": info["start_time"],
                        "zombie": True,
                    }
            except OSError:
                pass  # dead, skip
        self._save()

    # ── core operations ──────────────────────────────────────────

    def run(self, command: str, name: str, cwd: str | None = None) -> dict:
        with self._lock:
            if name in self._procs:
                p = self._procs[name]
                if p["proc"].poll() is None:
                    return {"error": f"'{name}' already running (pid {p['proc'].pid})"}

        proc = subprocess.Popen(
            command, shell=True, cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.PIPE,
        )
        buf = deque(maxlen=BUFFER_LINES)
        t = threading.Thread(target=self._reader, args=(proc, buf), daemon=True)
        t.start()

        with self._lock:
            self._procs[name] = {
                "proc": proc, "buffer": buf, "command": command,
                "start_time": time.time(), "zombie": False,
            }
            self._save()
        return {"name": name, "pid": proc.pid, "status": "running"}

    def status(self, name: str | None = None) -> dict:
        with self._lock:
            if name and name not in self._procs:
                return {"error": f"'{name}' not found"}
            targets = {name: self._procs[name]} if name else dict(self._procs)
        out = []
        for n, info in targets.items():
            rc = info["proc"].poll()
            buf = info["buffer"]
            last = list(buf)[-5:] if buf else []
            out.append({
                "name": n, "pid": info["proc"].pid,
                "status": "exited" if rc is not None else ("zombie" if info.get("zombie") else "running"),
                "exit_code": rc, "uptime_seconds": round(time.time() - info["start_time"]),
                "last_output_lines": last,
            })
        return out[0] if name else {"processes": out}

    def logs(self, name: str, lines: int = 50) -> dict:
        with self._lock:
            info = self._procs.get(name)
        if not info:
            return {"error": f"'{name}' not found"}
        return {"name": name, "lines": list(info["buffer"])[-lines:]}

    def stop(self, name: str, force: bool = False) -> dict:
        with self._lock:
            info = self._procs.get(name)
        if not info:
            return {"error": f"'{name}' not found"}
        proc = info["proc"]
        try:
            if force:
                proc.kill()
            else:
                proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        with self._lock:
            self._save()
        return {"name": name, "status": "stopped", "exit_code": proc.returncode}

    def send_input(self, name: str, text: str) -> dict:
        with self._lock:
            info = self._procs.get(name)
        if not info:
            return {"error": f"'{name}' not found"}
        try:
            info["proc"].stdin.write((text + "\n").encode())
            info["proc"].stdin.flush()
        except Exception as e:
            return {"error": str(e)}
        return {"ok": True}

    def cleanup(self):
        with self._lock:
            for info in self._procs.values():
                try:
                    info["proc"].kill()
                except Exception:
                    pass
            self._procs.clear()
            self._save()

    @staticmethod
    def _reader(proc: subprocess.Popen, buf: deque):
        for raw in proc.stdout:
            try:
                buf.append(raw.decode("utf-8", errors="replace").rstrip("\n"))
            except Exception:
                pass


class _ZombieProc:
    """Minimal stand-in for a Popen whose handle was lost (server restart)."""
    def __init__(self, pid: int):
        self.pid = pid
        self.returncode = None
    def poll(self):
        try:
            os.kill(self.pid, 0)
            return None
        except OSError:
            self.returncode = -1
            return -1
    def kill(self):
        os.kill(self.pid, signal.SIGKILL)
    def terminate(self):
        os.kill(self.pid, signal.SIGTERM)
    def wait(self, timeout=None):
        return self.returncode


# ── singleton ────────────────────────────────────────────────────

_mgr: ProcessManager | None = None


def _get_mgr() -> ProcessManager:
    assert _mgr is not None, "ProcessManager not initialized"
    return _mgr


# ── MCP tools ────────────────────────────────────────────────────

@mcp.tool()
def env_run(command: str, name: str, cwd: str | None = None) -> dict:
    """Start a background process. Returns immediately. stdout+stderr captured in ring buffer."""
    return _get_mgr().run(command, name, cwd)


@mcp.tool()
def env_status(name: str | None = None) -> dict:
    """Check process health. If name omitted, lists all. Returns {processes: [...]} for all, or single process dict."""
    return _get_mgr().status(name)


@mcp.tool()
def env_logs(name: str, lines: int = 50) -> dict:
    """Read last N lines of combined stdout+stderr."""
    return _get_mgr().logs(name, lines)


@mcp.tool()
def env_stop(name: str, force: bool = False) -> dict:
    """Stop a process. SIGTERM by default, SIGKILL if force=true."""
    return _get_mgr().stop(name, force)


@mcp.tool()
def env_input(name: str, text: str) -> dict:
    """Send text to process stdin (for interactive processes)."""
    return _get_mgr().send_input(name, text)


# ── main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()

    _mgr = ProcessManager(args.state_dir)
    atexit.register(_mgr.cleanup)
    signal.signal(signal.SIGTERM, lambda *_: (_mgr.cleanup(), exit(0)))

    mcp.run(transport="stdio")
