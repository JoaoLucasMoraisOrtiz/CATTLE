"""High-level Agent — composes PTY + parser. Throttled streaming, silence detection."""

import re
import time
from pty_agent import PtyProcess
from output_parser import strip_ansi, is_processing, is_prompt, clean_response, PROMPT_RE
from config import RESPONSE_TIMEOUT, STARTUP_TIMEOUT, PROCESSING_DETECT_TIMEOUT, PROMPT_TAIL_CHARS

SPINNER_RE = re.compile(r'^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]')
CHUNK_THROTTLE = 0.5
MAX_LOG = 10
MAX_SILENCE = 3  # 3 x 5s = 15s


class Agent:
    def __init__(self, name, workdir, model=None, mcps=None):
        self.name = name
        self._pty = PtyProcess(workdir, model, mcps)
        self.log = []
        self.on_chunk = None
        self._last_chunk_ts = 0
        self._chunk_buf = ''

    def start(self):
        self._pty.spawn()
        real_cb = self.on_chunk
        def filt(text):
            if not real_cb: return
            s = text.strip()
            if not s or s[0] in '⠀⢀⢰⢸⠸╭│╰' or 'Did you know' in s: return
            real_cb(text)
        self.on_chunk = filt
        raw = self._read_until_prompt(STARTUP_TIMEOUT)
        self.on_chunk = real_cb
        if not self._pty.is_alive():
            raise RuntimeError(f'Agent {self.name} died during startup: {raw[-500:]}')
        self._log_entry('startup', raw)
        return raw

    def send(self, message):
        if not self._pty.is_alive():
            raise RuntimeError(f'Agent {self.name} is not running')
        self._log_entry('send', message)
        self._chunk_buf = ''
        self._pty.write(message)
        self._skip_until_processing()
        raw = self._read_until_prompt(RESPONSE_TIMEOUT)
        self._flush_chunk()
        result = clean_response(raw, skip_text=message.strip())
        self._log_entry('recv', result)
        return result

    def quit(self):
        self._pty.kill()

    def _emit_chunk(self, clean):
        if not self.on_chunk: return
        s = clean.strip()
        if not s or SPINNER_RE.match(s): return
        self._chunk_buf += clean
        if time.time() - self._last_chunk_ts >= CHUNK_THROTTLE:
            self._flush_chunk()

    def _flush_chunk(self):
        if self._chunk_buf and self.on_chunk:
            self.on_chunk(self._chunk_buf)
            self._chunk_buf = ''
            self._last_chunk_ts = time.time()

    def _skip_until_processing(self):
        deadline = time.time() + PROCESSING_DETECT_TIMEOUT
        while time.time() < deadline:
            try:
                chunk = self._pty.read_chunk(timeout=2)
            except RuntimeError:
                return
            if chunk:
                clean = strip_ansi(chunk)
                if is_processing(clean):
                    self._emit_chunk(clean)
                    return

    def _read_until_prompt(self, timeout):
        buf = []
        tail_carry = ''
        silence = 0
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                chunk = self._pty.read_chunk(timeout=5)
            except RuntimeError:
                break
            if chunk is None:
                silence += 1
                if silence >= MAX_SILENCE:
                    break
                continue
            silence = 0
            buf.append(chunk)
            clean = strip_ansi(chunk)
            self._emit_chunk(clean)
            combined = tail_carry + clean
            if PROMPT_RE.search(combined[-PROMPT_TAIL_CHARS:]):
                break
            tail_carry = clean[-PROMPT_TAIL_CHARS:]
        return strip_ansi(''.join(buf))

    def _log_entry(self, event, data):
        self.log.append({'ts': time.time(), 'agent': self.name, 'event': event, 'data': data[:2000]})
        if len(self.log) > MAX_LOG:
            self.log = self.log[-MAX_LOG:]

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_):
        self.quit()
