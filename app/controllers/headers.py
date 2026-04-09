"""Header CRUD routes."""

from fastapi import APIRouter, HTTPException
from app.models.header import HeaderDef, AVAILABLE_PLACEHOLDERS
from app.models.schemas import HeaderIn
from app.services import header_service

router = APIRouter(prefix="/api/headers", tags=["headers"])


@router.get("")
def list_headers():
    header_service.ensure_defaults()
    return [h.__dict__ for h in header_service.load_all()]


@router.post("")
def create_header(h: HeaderIn):
    try:
        header_service.add(HeaderDef(**h.model_dump()))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/{header_id}")
def update_header(header_id: str, h: HeaderIn):
    header_service.update(HeaderDef(**{**h.model_dump(), 'id': header_id}))
    return {"ok": True}


@router.delete("/{header_id}")
def delete_header(header_id: str):
    try:
        header_service.remove(header_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{header_id}/set-default")
def set_default_header(header_id: str):
    try:
        header_service.set_default(header_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/placeholders")
def list_placeholders():
    return AVAILABLE_PLACEHOLDERS
