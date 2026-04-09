"""User settings — persisted in ~/.kiro-swarm/settings.json."""

import json
from pathlib import Path

_FILE = Path.home() / '.kiro-swarm' / 'settings.json'
_DEFAULTS = {'data_collection': True}


def _load() -> dict:
    if _FILE.exists():
        return {**_DEFAULTS, **json.loads(_FILE.read_text())}
    return dict(_DEFAULTS)


def _save(data: dict):
    _FILE.parent.mkdir(parents=True, exist_ok=True)
    _FILE.write_text(json.dumps(data, indent=2))


def get_all() -> dict:
    return _load()


def set_key(key: str, value):
    data = _load()
    data[key] = value
    _save(data)
    return data
