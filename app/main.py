"""FastAPI application factory — mounts static files and includes all routers."""

from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.controllers import all_routers

STATIC_DIR = Path(__file__).parent.parent / 'static'


def create_app() -> FastAPI:
    app = FastAPI(title="ReDo!")
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    for router in all_routers:
        app.include_router(router)

    @app.get("/")
    def index():
        return FileResponse(str(STATIC_DIR / "index.html"))

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8420)
