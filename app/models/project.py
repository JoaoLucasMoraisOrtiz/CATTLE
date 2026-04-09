"""Project data model."""

from dataclasses import dataclass


@dataclass
class Project:
    id: str
    name: str
    path: str
