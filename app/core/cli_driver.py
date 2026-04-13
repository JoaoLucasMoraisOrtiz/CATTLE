"""CLI driver abstraction — defines how to interact with different CLI tools."""

import re
from dataclasses import dataclass, field


@dataclass
class CliDriver:
    """Base configuration for a CLI tool."""
    name: str
    spawn_cmd: str
    prompt_re: re.Pattern
    processing_keywords: tuple[str, ...]
    idle_pattern: str  # text that appears when CLI is ready for input
    submit_suffix: str = '\r'
    quit_cmd: str = ''
    compact_cmd: str = ''
    model_flag: str = ''
    yolo_flag: str = ''
    response_prefix: str = ''  # prefix on response lines (e.g. '✦' for gemini)
    tui_chrome_re: re.Pattern | None = None  # regex to strip TUI decorations


KIRO_DRIVER = CliDriver(
    name='kiro',
    spawn_cmd='kiro-cli chat --wrap never -a',
    prompt_re=re.compile(r'\d+%.*?!>'),
    processing_keywords=('Thinking', 'Using tool:'),
    idle_pattern='!>',
    quit_cmd='/quit',
    compact_cmd='/compact',
    model_flag='--model',
)

GEMINI_DRIVER = CliDriver(
    name='gemini',
    spawn_cmd='gemini --approval-mode auto_edit',
    prompt_re=re.compile(r'Type your message|for shortcuts'),
    processing_keywords=('Thinking', 'Responding'),
    idle_pattern='Type your message',
    quit_cmd='/quit',
    compact_cmd='',  # gemini has no compact
    model_flag='--model',
    yolo_flag='--yolo',
    response_prefix='✦',
    tui_chrome_re=re.compile(
        r'^[─▀▄│╭╮╰╯▐▌░▒▓█\s]+$'
        r'|^\s*YOLO\b'
        r'|^\s*workspace\b'
        r'|^\s*/mnt/'
        r'|^\s*sandbox\b'
        r'|^\s*\? for shortcuts'
        r'|^\s*Type your message'
        r'|^\s*Gemini CLI'
        r'|^\s*Signed in with'
        r'|^\s*Plan:'
        r'|^\s*MCP servers'
        r'|^\s*Waiting for auth'
        r'|^\s*Read more:'
        r'|^\s*We.re making changes'
        r'|^\s*What.s Changing'
        r'|^\s*How it affects'
        r'|^\s*periods of high'
        r'|^\s*Tips for getting'
        r'|^\s*\d+\.\s*(Create GEMINI|/help|Ask coding|Be specific)'
        r'|^\s*Auto \(Gemini'
        r'|^\s*no sandbox'
        r'|^\s*branch\b'
        r'|^\x1b'
    ),
)

DRIVERS = {'kiro': KIRO_DRIVER, 'gemini': GEMINI_DRIVER}


def get_driver(cli_type: str) -> CliDriver:
    return DRIVERS.get(cli_type, KIRO_DRIVER)
