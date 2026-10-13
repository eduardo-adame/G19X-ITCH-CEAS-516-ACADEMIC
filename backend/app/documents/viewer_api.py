"""Transporte protegido del visor documental independiente."""
from __future__ import annotations

from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
import psycopg

from app.config import Settings
from app.documents.viewer_models import ViewerContent, ViewerNotFound, ViewerPage, ViewerQuery, ViewerUnavailable, ViewerVersionChanged
from app.documents.viewer_repository import ViewerRepository
from app.documents.viewer_service import ViewerService
from app.security.api import current_principal, security_settings, service_for
from app.security.models import AuthenticatedPrincipal, AuthenticationError, AuditPersistenceError, SecurityError
from app.security.service import SecurityService
from app.storage.abstraction import StorageAbstraction


_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


class ViewerRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def protected(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse({"detail": "Parámetros no válidos"}, status_code=422)
            except HTTPException as exc:
                response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)
            response.headers.update(_HEADERS)
            return response

        return protected


router = APIRouter(prefix="/viewer", tags=["document-viewer"], route_class=ViewerRoute)


def viewer_service_for(request: Request, security: SecurityService = Depends(service_for),
                       settings: Settings = Depends(security_settings)) -> ViewerService:
    return getattr(request.app.state, "viewer_service", None) or ViewerService(
        ViewerRepository(security.repository), security, StorageAbstraction(Path(settings.ingestion_storage_root)),
        max_file_bytes=settings.ingestion_max_file_bytes,
    )


def _error(exc):
    if isinstance(exc, (AuditPersistenceError, ViewerUnavailable, psycopg.Error)):
        return HTTPException(503, "Operación no confirmada")
    if isinstance(exc, AuthenticationError):
        return HTTPException(401, "Credenciales o sesión no válidas")
    if isinstance(exc, SecurityError):
        return HTTPException(403, "Acceso no autorizado")
    if isinstance(exc, ViewerNotFound):
        return HTTPException(404, "Documento no disponible")
    if isinstance(exc, ViewerVersionChanged):
        return HTTPException(409, "La versión del documento cambió; actualiza la selección")
    return HTTPException(422, "Parámetros no válidos")


_ERRORS = (SecurityError, ViewerUnavailable, ViewerNotFound, ViewerVersionChanged, psycopg.Error, ValueError)


@router.get("", response_model=ViewerPage)
def catalog(query: ViewerQuery = Query(), principal: AuthenticatedPrincipal = Depends(current_principal),
            service: ViewerService = Depends(viewer_service_for)):
    try:
        return service.catalog(query, principal)
    except _ERRORS as exc:
        raise _error(exc) from None


@router.get("/{document_id}/original")
def original(document_id: str, version_id: UUID = Query(),
             principal: AuthenticatedPrincipal = Depends(current_principal),
             service: ViewerService = Depends(viewer_service_for)):
    try:
        payload = service.read(document_id, version_id, principal, original=True)
        return Response(payload, media_type="application/pdf", headers={
            "Content-Disposition": 'inline; filename="document.pdf"', **_HEADERS})
    except _ERRORS as exc:
        raise _error(exc) from None


@router.get("/{document_id}", response_model=ViewerContent)
def content(document_id: str, version_id: UUID | None = Query(default=None),
            principal: AuthenticatedPrincipal = Depends(current_principal),
            service: ViewerService = Depends(viewer_service_for)):
    try:
        return service.read(document_id, version_id, principal)
    except _ERRORS as exc:
        raise _error(exc) from None
