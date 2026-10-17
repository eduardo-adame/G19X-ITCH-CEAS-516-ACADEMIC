"""Transporte HTTP de las consultas administrativas de solo lectura (RF-068, SRS 0.26)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from app.security.api import current_principal, service_for, unauthenticated, unauthorized
from app.security.directory import AccountPage, AccountQuery, DocumentExceptionPage, ExceptionQuery, ScopeGrantList
from app.security.models import AuditPersistenceError, AuthenticatedPrincipal, AuthenticationError, AuthorizationError
from app.security.service import SecurityService

# Datos personales de cuentas: nunca en caché y sin repetir la entrada en los errores de validación.
_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


class DirectoryRoute(APIRoute):
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


router = APIRouter(prefix="/api/security", tags=["security-directory"], route_class=DirectoryRoute)


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, AuthenticationError):
        return unauthenticated()
    if isinstance(exc, AuthorizationError):
        return unauthorized()
    if isinstance(exc, AuditPersistenceError):
        return HTTPException(503, "Operación no confirmada")
    return HTTPException(422, "Parámetros no válidos")


_ERRORS = (AuthenticationError, AuthorizationError, AuditPersistenceError, ValueError)


@router.get("/users", response_model=AccountPage)
def list_accounts(query: AccountQuery = Query(), principal: AuthenticatedPrincipal = Depends(current_principal),
                  service: SecurityService = Depends(service_for)):
    try:
        return service.list_accounts(principal, query)
    except _ERRORS as exc:
        raise _error(exc) from None


@router.get("/document-scopes", response_model=ScopeGrantList)
def list_scope_grants(principal: AuthenticatedPrincipal = Depends(current_principal),
                      service: SecurityService = Depends(service_for)):
    try:
        return service.list_scope_grants(principal)
    except _ERRORS as exc:
        raise _error(exc) from None


@router.get("/document-exceptions", response_model=DocumentExceptionPage)
def list_document_exceptions(query: ExceptionQuery = Query(), principal: AuthenticatedPrincipal = Depends(current_principal),
                             service: SecurityService = Depends(service_for)):
    try:
        return service.list_document_exceptions(principal, query)
    except _ERRORS as exc:
        raise _error(exc) from None
