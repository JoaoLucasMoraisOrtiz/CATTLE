"""Controllers package — aggregates all routers."""

from app.controllers.agents import router as agents_router
from app.controllers.flows import router as flows_router
from app.controllers.projects import router as projects_router
from app.controllers.headers import router as headers_router
from app.controllers.settings import router as settings_router
from app.controllers.session import router as session_router

all_routers = [
    agents_router,
    flows_router,
    projects_router,
    headers_router,
    settings_router,
    session_router,
]
