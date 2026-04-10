"""Output parsing — ANSI stripping, spinner removal, prompt detection."""

import re
from app.config import PROMPT_TAIL_CHARS

ANSI_RE = re.compile(
    r'\x1b\[[0-9;?]*[a-zA-Z]'
    r'|\x1b\][^\x07]*\x07'
    r'|\x1b[78DEHM]'
    r'|\x1b\(B'
    r'|\r'
)
SPINNER_THINKING_RE = re.compile(r'[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.\.\.')
PROMPT_RE = re.compile(r'\d+%.*?!>')
PROCESSING_KEYWORDS = ('Thinking', 'Using tool:')


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub('', text)


def is_processing(chunk_clean: str) -> bool:
    return any(kw in chunk_clean for kw in PROCESSING_KEYWORDS)


def is_prompt(chunk_clean: str) -> bool:
    tail = chunk_clean[-PROMPT_TAIL_CHARS:]
    return bool(PROMPT_RE.search(tail))


def clean_response(text: str, skip_text: str = '', driver=None) -> str:
    text = SPINNER_THINKING_RE.sub('', text)
    prompt_re = driver.prompt_re if driver else PROMPT_RE
    chrome_re = driver.tui_chrome_re if driver else None
    lines = text.split('\n')
    filtered = []
    for line in lines:
        s = line.strip()
        if s.startswith('▸ Time:'):
            continue
        if skip_text and s == skip_text:
            continue
        if chrome_re and chrome_re.match(s):
            continue
        m = prompt_re.search(s)
        if m:
            before = s[:m.start()].rstrip()
            if before:
                filtered.append(before)
            continue
        filtered.append(line)
    return '\n'.join(filtered).strip()
