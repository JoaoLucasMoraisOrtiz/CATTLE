"""Project registry — CRUD + persistence."""

import json
from dataclasses import asdict
from pathlib import Path

from app.models.project import Project

PROJECTS_FILE = Path.home() / '.kiro-swarm' / 'projects.json'


def load() -> list[Project]:
    PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not PROJECTS_FILE.exists():
        return []
    return [Project(**p) for p in json.loads(PROJECTS_FILE.read_text())]


def save(projects: list[Project]) -> None:
    PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROJECTS_FILE.write_text(json.dumps([asdict(p) for p in projects], indent=2, ensure_ascii=False))


def add(project: Project) -> None:
    projects = load()
    if any(p.id == project.id for p in projects):
        raise ValueError(f'Project "{project.id}" already exists')
    projects.append(project)
    save(projects)


def remove(project_id: str) -> None:
    save([p for p in load() if p.id != project_id])


def get(project_id: str) -> Project | None:
    return next((p for p in load() if p.id == project_id), None)
