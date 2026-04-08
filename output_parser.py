"""Output parsing — ANSI stripping, spinner removal, prompt detection."""

import re
from config import PROMPT_TAIL_CHARS

ANSI_RE = re.compile(
    r'\x1b\[[0-9;?]*[a-zA-Z]'
    r'|\x1b\][^\x07]*\x07'
    r'|\x1b[78DEHM]'
    r'|\x1b\(B'
    r'|\r'
)
SPINNER_THINKING_RE = re.compile(r'[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.\.\.')
PROMPT_RE = re.compile(r'\d+%.*?!>')
PROCESSING_KEYWORDS = ('Thinking', 'Using tool:')  # fix: removed generic 'tool'


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub('', text)


def is_processing(chunk_clean: str) -> bool:
    return any(kw in chunk_clean for kw in PROCESSING_KEYWORDS)


def is_prompt(chunk_clean: str) -> bool:
    """True if the kiro prompt appears in the tail of this chunk."""
    tail = chunk_clean[-PROMPT_TAIL_CHARS:]
    return bool(PROMPT_RE.search(tail))


def clean_response(text: str, skip_text: str = '') -> str:
    """Remove spinners, timing, prompts, echoed input. Preserve blank lines."""
    text = SPINNER_THINKING_RE.sub('', text)
    lines = text.split('\n')
    filtered = []
    for line in lines:
        s = line.strip()
        if s.startswith('▸ Time:'):
            continue
        if skip_text and s == skip_text:
            continue
        # Truncate line at prompt pattern (handles mid-line prompts)
        m = PROMPT_RE.search(s)
        if m:
            before = s[:m.start()].rstrip()
            if before:
                filtered.append(before)
            continue
        filtered.append(line)  # keep blank lines for formatting
    return '\n'.join(filtered).strip()
