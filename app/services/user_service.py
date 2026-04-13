"""User service — CRUD + JSON persistence + password hashing."""

import json
import os
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import List, Optional
from passlib.context import CryptContext

from app.models.user import User

USERS_FILE = Path.home() / '.kiro-swarm' / 'users.json'

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def load() -> List[User]:
    USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not USERS_FILE.exists():
        return []
    try:
        return [User(**u) for u in json.loads(USERS_FILE.read_text())]
    except Exception:
        return []


def save(users: List[User]) -> None:
    USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    USERS_FILE.write_text(json.dumps([asdict(u) for u in users], indent=2, ensure_ascii=False))


def add(username: str, password_hash: str, role: str = "user") -> User:
    users = load()
    if any(u.username == username for u in users):
        raise ValueError(f'User "{username}" already exists')
    
    new_user = User(
        id=str(uuid.uuid4()),
        username=username,
        password_hash=password_hash,
        role=role
    )
    users.append(new_user)
    save(users)
    return new_user


def get_by_username(username: str) -> Optional[User]:
    return next((u for u in load() if u.username == username), None)


def get_by_id(user_id: str) -> Optional[User]:
    return next((u for u in load() if u.id == user_id), None)
