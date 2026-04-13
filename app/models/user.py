from dataclasses import dataclass, asdict
from typing import Optional

@dataclass
class User:
    username: str
    password_hash: str
    id: Optional[str] = None
    role: str = "user"

    def to_dict(self):
        return asdict(self)
