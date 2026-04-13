"""High-level Agent — composes PTY + parser. Throttled streaming, silence detection."""

import re
import time
from app.core.pty_agent import PtyProcess
from app.core.output_parser import strip_ansi, clean_response
from app.config import RESPONSE_TIMEOUT, STARTUP_TIMEOUT, PROCESSING_DETECT_TIMEOUT, PROMPT_TAIL_CHARS

SPINNER_RE = re.compile(r'^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]')
CHUNK_THROTTLE = 0.5
MAX_LOG = 10
MAX_SILENCE = 3


class Agent:
    def __init__(self, name, workdir, model=None, mcps=None, cli_type='kiro'):
        self.name = name
        self.cli_type = cli_type
        self._pty = PtyProcess(workdir, model, mcps, cli_type)
        self._driver = self._pty.driver
        self.log = []
        self.on_chunk = None
        self._last_chunk_ts = 0
        self._chunk_buf = ''
        self._last_screen = ''

    def _is_processing(self, text):
        if any(kw in text for kw in self._driver.processing_keywords):
            return True
        # For TUI CLIs, also check screen
        if self._pty._screen:
            return any(
                kw in line for line in self._pty._screen.display for kw in self._driver.processing_keywords
            )
        return False

    def _is_prompt(self, text):
        # For TUI CLIs, check the virtual screen
        if self._pty._screen:
            screen_has_idle = self._pty.screen_contains(self._driver.idle_pattern)
            screen_has_processing = any(
                kw in line for line in self._pty._screen.display for kw in self._driver.processing_keywords
            )
            # Only consider it "prompt" if idle is showing AND not processing
            return screen_has_idle and not screen_has_processing
        return bool(self._driver.prompt_re.search(text[-PROMPT_TAIL_CHARS:]))

    def _is_tui_chrome(self, line):
        if not self._driver.tui_chrome_re:
            return False
        return bool(self._driver.tui_chrome_re.match(line.strip()))

    def start(self):
        self._pty.spawn()
        real_cb = self.on_chunk
        self.on_chunk = None  # suppress ALL output during startup
        raw = self._read_until_prompt(STARTUP_TIMEOUT)
        # Handle gemini trust dialog
        if self._pty._screen and self._pty.screen_contains('Trust folder'):
            self._pty.proc.send('1')
            time.sleep(2)
            raw += self._read_until_prompt(STARTUP_TIMEOUT)
        # Handle gemini auth dialog
        if self._pty._screen and self._pty.screen_contains('Waiting for authentication'):
            raw += self._read_until_prompt(STARTUP_TIMEOUT)
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

        if self._pty._screen:
            result = self._send_tui(message)
        else:
            result = self._send_line(message)

        self._flush_chunk()
        result = clean_response(result, skip_text=message.strip(), driver=self._driver)
        self._log_entry('recv', result)
        return result

    def _send_tui(self, message):
        """Read loop for TUI-based CLIs (gemini). Uses pyte screen for state detection."""
        buf = []
        saw_processing = False
        deadline = time.time() + RESPONSE_TIMEOUT
        silence = 0
        while time.time() < deadline:
            try:
                chunk = self._pty.read_chunk(timeout=3)
            except RuntimeError:
                break
            if chunk is None:
                if saw_processing:
                    # Check if back to idle (processing done)
                    if self._pty.screen_contains(self._driver.idle_pattern):
                        screen_processing = any(
                            kw in line for line in self._pty._screen.display for kw in self._driver.processing_keywords
                        )
                        if not screen_processing:
                            break
                    silence += 1
                    if silence >= MAX_SILENCE * 2:
                        break
                continue
            silence = 0
            clean = strip_ansi(chunk)
            # Detect processing start
            if not saw_processing and self._is_processing(clean):
                saw_processing = True
            if saw_processing:
                # Extract response content (lines with ✦ prefix)
                if self._driver.response_prefix:
                    for line in clean.split('\n'):
                        s = line.strip()
                        if s.startswith(self._driver.response_prefix):
                            content = s[len(self._driver.response_prefix):].strip()
                            buf.append(content)
                            self._emit_chunk(content + '\n')
                else:
                    buf.append(clean)
                    self._emit_chunk(clean)
        return '\n'.join(buf)

    def _send_line(self, message):
        buf = []
        tail_carry = ''
        silence = 0
        streaming = False
        echo_deadline = time.time() + PROCESSING_DETECT_TIMEOUT
        deadline = time.time() + RESPONSE_TIMEOUT
        while time.time() < deadline:
            try:
                chunk = self._pty.read_chunk(timeout=5)
            except RuntimeError:
                break
            if chunk is None:
                if streaming:
                    silence += 1
                    if silence >= MAX_SILENCE:
                        break
                elif time.time() > echo_deadline:
                    streaming = True
                continue
            silence = 0
            clean = strip_ansi(chunk)
            if not streaming and self._is_processing(clean):
                streaming = True
                buf.clear()
                tail_carry = ''
            if not streaming:
                if self._is_prompt(clean):
                    tail_carry = ''
                continue
            buf.append(chunk)
            self._emit_chunk(clean)
            combined = tail_carry + clean
            if self._is_prompt(combined):
                break
            tail_carry = clean[-PROMPT_TAIL_CHARS:]
        raw = strip_ansi(''.join(buf))
        return raw

    def quit(self):
        self._pty.kill()

    def _emit_chunk(self, clean):
        if not self.on_chunk: return
        s = clean.strip()
        if not s or SPINNER_RE.match(s): return
        # For TUI CLIs: send screen snapshot (replace mode)
        if self._pty._screen:
            lines = []
            for line in self._pty._screen.display:
                s = line.rstrip()
                if s:
                    lines.append(s)
            screen_text = '\n'.join(lines)
            if screen_text != self._last_screen:
                self._last_screen = screen_text
                if self.on_chunk:
                    self.on_chunk(screen_text, True)  # True = replace
            return
        self._chunk_buf += clean
        if time.time() - self._last_chunk_ts >= CHUNK_THROTTLE:
            self._flush_chunk()

    def _flush_chunk(self):
        if self._chunk_buf and self.on_chunk:
            self.on_chunk(self._chunk_buf)
            self._chunk_buf = ''
            self._last_chunk_ts = time.time()

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
                    # For TUI CLIs, check screen on silence
                    if self._pty._screen and self._is_prompt(''):
                        break
                    if silence >= MAX_SILENCE * 2:
                        break
                continue
            silence = 0
            buf.append(chunk)
            clean = strip_ansi(chunk)
            self._emit_chunk(clean)
            combined = tail_carry + clean
            if self._is_prompt(combined):
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
