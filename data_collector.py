"""Training data collector — saves input/output pairs per agent as JSONL."""

import json, os, time, threading
from pathlib import Path

_lock = threading.Lock()


def _training_dir(project_path: str) -> Path:
    d = Path(project_path) / '.kiro-swarm' / 'training_data'
    d.mkdir(parents=True, exist_ok=True)
    return d


def collect(project_path: str, agent_id: str, agent_name: str,
            input_msg: str, output_msg: str, signal_kind: str = ''):
    """Append one training sample to the agent's JSONL file."""
    entry = {
        'agent_id': agent_id,
        'agent_name': agent_name,
        'input': input_msg.strip(),
        'output': output_msg.strip(),
        'signal': signal_kind,
        'ts': time.time(),
    }
    path = _training_dir(project_path) / f'{agent_id}.jsonl'
    line = json.dumps(entry, ensure_ascii=False) + '\n'
    with _lock:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line)
