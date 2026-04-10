"""CLI provider management — detect installed CLIs and auth status."""

import subprocess
import shutil
import os
from app.core.cli_driver import DRIVERS


def check_provider(name: str) -> dict:
    """Check if a CLI provider is installed and authenticated."""
    driver = DRIVERS.get(name)
    if not driver:
        return {'name': name, 'installed': False, 'authenticated': False, 'version': '', 'error': 'Unknown provider'}

    # Check if binary exists
    binary = driver.spawn_cmd.split()[0]
    installed = shutil.which(binary) is not None
    if not installed:
        return {'name': name, 'installed': False, 'authenticated': False, 'version': '', 'error': f'{binary} not found in PATH'}

    # Get version
    version = ''
    try:
        r = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=5)
        version = r.stdout.strip() or r.stderr.strip()
        version = version.split('\n')[0][:60]
    except Exception:
        pass

    # Check auth
    authenticated = False
    if name == 'kiro':
        # kiro-cli is always "authenticated" (uses AWS/Kiro account)
        authenticated = True
    elif name == 'gemini':
        creds = os.path.expanduser('~/.gemini/oauth_creds.json')
        authenticated = os.path.exists(creds)

    return {'name': name, 'installed': installed, 'authenticated': authenticated, 'version': version, 'error': ''}


def list_providers() -> list[dict]:
    return [check_provider(name) for name in DRIVERS]
