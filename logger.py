"""Logger — colored terminal output and transcript persistence."""

import json
from datetime import datetime
from pathlib import Path

# ANSI colors
_R = '\033[0m'
_B = '\033[1m'
_DIM = '\033[2m'
COLORS = {
    'orch':      '\033[93m',  # yellow
    'analyst':   '\033[94m',  # blue
    'architect': '\033[92m',  # green
    'error':     '\033[91m',  # red
    'ts':        '\033[96m',  # cyan
}


def _ts() -> str:
    return datetime.now().strftime('%H:%M:%S')


class Logger:
    def __init__(self):
        self.transcript: list[dict] = []

    def orch(self, msg: str) -> None:
        c = COLORS['ts']
        o = COLORS['orch']
        print(f'{c}[{_ts()}]{_R} {o}[ORCH]{_R} {msg}')

    def agent(self, name: str, event: str, text: str) -> None:
        color = COLORS.get(name.lower(), COLORS['orch'])
        header = f'{COLORS["ts"]}[{_ts()}]{_R} {color}{_B}[{name}]{_R} {_DIM}{event}{_R}'
        print(header)
        if text:
            for line in text.split('\n'):
                print(f'  {color}│{_R} {line}')
        print()

    def error(self, msg: str) -> None:
        print(f'{COLORS["ts"]}[{_ts()}]{_R} {COLORS["error"]}[ERROR]{_R} {msg}')

    def record(self, round_num: int, agent_name: str, response: str) -> None:
        self.transcript.append({
            'round': round_num, 'agent': agent_name, 'response': response,
        })

    def save_transcript(self, outdir: Path) -> None:
        outdir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        path = outdir / f'transcript_{stamp}.json'
        with open(path, 'w') as f:
            json.dump(self.transcript, f, indent=2, ensure_ascii=False, default=str)
        self.orch(f'Transcript saved to {path}')
