"""Project CRUD routes."""

from fastapi import APIRouter, HTTPException
from app.models.project import Project
from app.models.schemas import ProjectIn
from app.services import project_service

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
def list_projects():
    return [p.__dict__ for p in project_service.load()]


@router.post("")
def create_project(p: ProjectIn):
    try:
        project_service.add(Project(**p.model_dump()))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/{project_id}")
def delete_project(project_id: str):
    project_service.remove(project_id)
    return {"ok": True}
