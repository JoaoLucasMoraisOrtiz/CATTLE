"""Git checkpoints — auto-commit after each round, rollback on error."""

import subprocess
import os


class GitCheckpoint:
    def __init__(self, workdir: str):
        self.workdir = os.path.abspath(workdir)
        self._initial_hash: str | None = None

    def _run(self, *args: str) -> str:
        r = subprocess.run(
            ['git'] + list(args),
            cwd=self.workdir, capture_output=True, text=True, timeout=30,
        )
        return r.stdout.strip()

    def _is_repo(self) -> bool:
        try:
            self._run('rev-parse', '--git-dir')
            return True
        except Exception:
            return False

    def init(self) -> bool:
        """Save initial state. Returns False if not a git repo."""
        if not self._is_repo():
            return False
        self._initial_hash = self._run('rev-parse', 'HEAD')
        # Stash any uncommitted work first
        self._run('stash', 'push', '-m', 'kiro-swarm: pre-run stash')
        return True

    def commit(self, round_num: int, agent_name: str) -> str | None:
        """Commit current state. Returns commit hash or None."""
        try:
            self._run('add', '-A')
            # Check if there's anything to commit
            status = self._run('diff', '--cached', '--quiet')
            self._run('commit', '-m', f'swarm: round {round_num} - {agent_name}', '--allow-empty')
            return self._run('rev-parse', 'HEAD')
        except Exception:
            return None

    def rollback(self, commit_hash: str) -> bool:
        """Hard reset to a specific commit."""
        try:
            self._run('reset', '--hard', commit_hash)
            return True
        except Exception:
            return False

    def rollback_to_initial(self) -> bool:
        """Reset to state before swarm started."""
        if self._initial_hash:
            return self.rollback(self._initial_hash)
        return False

    def finish(self) -> None:
        """Restore stashed work if swarm is done cleanly."""
        try:
            self._run('stash', 'pop')
        except Exception:
            pass  # no stash to pop
