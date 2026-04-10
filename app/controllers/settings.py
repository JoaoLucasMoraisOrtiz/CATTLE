"""Settings routes."""

from fastapi import APIRouter
from app.models.schemas import SettingIn
from app.services import settings_service
from app.services.provider_service import list_providers

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings():
    return settings_service.get_all()


@router.put("")
def update_setting(body: SettingIn):
    return settings_service.set_key(body.key, body.value)


@router.get("/providers")
def get_providers():
    return list_providers()
