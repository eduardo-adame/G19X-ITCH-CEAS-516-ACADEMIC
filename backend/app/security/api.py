"""Transporte HTTP para los casos de uso de seguridad."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.security.models import (
    AccountConflictError,
    AuditPersistenceError,
    AuthenticatedPrincipal,
    AuthenticationError,
    AuthorizationError,
    LastActiveTiError,
    SecurityError,
    ValidationError,
)
from app.security.repository import SecurityRepository
from app.security.service import SecurityService
from app.security.tokens import JwtService


router = APIRouter(prefix="/api", tags=["security"])
ACCOUNT_CONFLICT_DETAIL = "No fue posible crear el usuario porque los datos entran en conflicto con un registro existente."
LAST_TI_DETAIL = "La operación dejaría el sistema sin ninguna cuenta TI activa."
_bearer = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=128)


class PasswordRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class AccountCreateRequest(LoginRequest):
    display_name: str = Field(min_length=1, max_length=256)
    roles: set[str] = Field(min_length=1)


class AccountUpdateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=256)


class RolesRequest(BaseModel):
    roles: set[str] = Field(min_length=1)


class ScopeGrantRequest(BaseModel):
    active: bool


class ExceptionRequest(BaseModel):
    decision: Literal["ALLOW", "DENY"]
    active: bool


@lru_cache(maxsize=1)
def configured_security_service() -> SecurityService:
    """Construye el servicio solo cuando una ruta protegida lo necesita."""
    settings = get_settings()
    if settings.environment.lower() != "development" and not settings.refresh_cookie_secure:
        raise RuntimeError("La cookie de refresh debe ser Secure fuera de desarrollo")
    return SecurityService(
        SecurityRepository(settings.psycopg_conninfo),
        JwtService(
            issuer=settings.security_jwt_issuer,
            audience=settings.security_jwt_audience,
            keyring=settings.jwt_keyring,
            active_kid=settings.security_jwt_active_kid,
        ),
    )


def service_for(request: Request) -> SecurityService:
    return getattr(request.app.state, "security_service", None) or configured_security_service()


def security_settings(request: Request) -> Settings:
    return getattr(request.app.state, "security_settings", None) or get_settings()


def unauthenticated() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales o sesión no válidas")


def unavailable() -> HTTPException:
    # La identidad no puede validarse porque la persistencia no responde: se deniega igual, pero sin presentarlo como
    # credenciales o sesión inválidas, para que el cliente conserve la sesión e informe la indisponibilidad.
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Servicio no disponible temporalmente")


def unauthorized() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Acceso no autorizado")


def current_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> AuthenticatedPrincipal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthenticated()
    try:
        return service_for(request).authenticated_principal(credentials.credentials)
    except AuditPersistenceError:
        raise unavailable() from None
    except (AuthenticationError, SecurityError):
        raise unauthenticated() from None


def require(capability: str):
    def dependency(request: Request, principal: AuthenticatedPrincipal = Depends(current_principal)) -> AuthenticatedPrincipal:
        try:
            service_for(request).require_functional_permission(principal, capability)
        except SecurityError:
            raise unauthorized() from None
        return principal
    return dependency


def admin_error(exc: SecurityError, invalid_detail: str) -> HTTPException:
    """Traduce el error de una operación administrativa sin revelar si una cuenta existe.

    La cuenta inexistente y la falta de permiso siguen siendo 403; los datos inválidos son 422, dejar el
    sistema sin TI activo es 409 y una auditoría no confirmada es 503.
    """
    if isinstance(exc, AuthenticationError):
        return unauthenticated()
    if isinstance(exc, LastActiveTiError):
        return HTTPException(status_code=409, detail=LAST_TI_DETAIL)
    if isinstance(exc, AccountConflictError):
        return HTTPException(status_code=409, detail=ACCOUNT_CONFLICT_DETAIL)
    if isinstance(exc, ValidationError):
        return HTTPException(status_code=422, detail=invalid_detail)
    if isinstance(exc, AuditPersistenceError):
        return HTTPException(status_code=503, detail="Operación no confirmada")
    return unauthorized()


def set_refresh_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        key=settings.security_refresh_cookie_name,
        value=token,
        httponly=True,
        samesite="strict",
        secure=settings.refresh_cookie_secure,
        max_age=8 * 60 * 60,
        path="/api/auth",
    )


@router.post("/auth/login")
def login(payload: LoginRequest, response: Response, service: SecurityService = Depends(service_for), settings: Settings = Depends(security_settings)) -> dict[str, str]:
    try:
        access_token, refresh_token = service.login(payload.username, payload.password)
    except AuditPersistenceError:
        raise unavailable() from None
    except SecurityError:
        raise unauthenticated() from None
    set_refresh_cookie(response, refresh_token, settings)
    return {"access_token": access_token, "token_type": "bearer"}


@router.post("/auth/refresh")
def refresh(request: Request, response: Response, service: SecurityService = Depends(service_for), settings: Settings = Depends(security_settings)) -> dict[str, str]:
    refresh_token = request.cookies.get(settings.security_refresh_cookie_name)
    if not refresh_token:
        raise unauthenticated()
    try:
        access_token, replacement = service.refresh(refresh_token)
    except AuditPersistenceError:
        raise unavailable() from None
    except SecurityError:
        raise unauthenticated() from None
    set_refresh_cookie(response, replacement, settings)
    return {"access_token": access_token, "token_type": "bearer"}


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, principal: AuthenticatedPrincipal = Depends(current_principal), service: SecurityService = Depends(service_for), settings: Settings = Depends(security_settings)) -> Response:
    try:
        service.logout(principal)
    except SecurityError:
        raise unauthenticated() from None
    response.status_code = status.HTTP_204_NO_CONTENT
    response.delete_cookie(settings.security_refresh_cookie_name, path="/api/auth", httponly=True, samesite="strict", secure=settings.refresh_cookie_secure)
    return response


@router.get("/auth/me")
def me(principal: AuthenticatedPrincipal = Depends(current_principal)) -> dict[str, object]:
    # El nombre asignado solo se presenta; si una identidad no lo trae se usa el usuario.
    return {"id": str(principal.account_id), "username": principal.username, "display_name": principal.display_name or principal.username, "roles": sorted(principal.roles)}


@router.post("/security/users", status_code=status.HTTP_201_CREATED)
def create_user(payload: AccountCreateRequest, principal: AuthenticatedPrincipal = Depends(require("user.create")), service: SecurityService = Depends(service_for)) -> dict[str, str]:
    try:
        account_id = service.create_account(principal, username=payload.username, display_name=payload.display_name, password=payload.password, roles=frozenset(payload.roles))
    except SecurityError as exc:
        # Conflicto de identidad única: mensaje genérico que no confirma qué dato existe.
        raise admin_error(exc, "Datos de cuenta no válidos") from None
    return {"id": str(account_id)}


@router.patch("/security/users/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def update_user(account_id: UUID, payload: AccountUpdateRequest, principal: AuthenticatedPrincipal = Depends(require("user.update")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.update_account(principal, account_id, payload.display_name)
    except SecurityError as exc:
        raise admin_error(exc, "Datos de cuenta no válidos") from None
    return Response(status_code=204)


@router.post("/security/users/{account_id}/activate", status_code=status.HTTP_204_NO_CONTENT)
def activate_user(account_id: UUID, principal: AuthenticatedPrincipal = Depends(require("user.update")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.activate_account(principal, account_id)
    except SecurityError as exc:
        raise admin_error(exc, "Datos de cuenta no válidos") from None
    return Response(status_code=204)


@router.post("/security/users/{account_id}/disable", status_code=status.HTTP_204_NO_CONTENT)
def disable_user(account_id: UUID, principal: AuthenticatedPrincipal = Depends(require("user.disable")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.disable_account(principal, account_id)
    except SecurityError as exc:
        raise admin_error(exc, "Datos de cuenta no válidos") from None
    return Response(status_code=204)


@router.post("/security/users/{account_id}/reset-access", status_code=status.HTTP_204_NO_CONTENT)
def reset_access(account_id: UUID, payload: PasswordRequest, principal: AuthenticatedPrincipal = Depends(require("user.reset_access")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.reset_access(principal, account_id, payload.password)
    except SecurityError as exc:
        raise admin_error(exc, "Datos de cuenta no válidos") from None
    return Response(status_code=204)


@router.put("/security/users/{account_id}/roles", status_code=status.HTTP_204_NO_CONTENT)
def replace_roles(account_id: UUID, payload: RolesRequest, principal: AuthenticatedPrincipal = Depends(require("role.assign")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.assign_roles(principal, account_id, frozenset(payload.roles))
    except SecurityError as exc:
        raise admin_error(exc, "Datos de cuenta no válidos") from None
    return Response(status_code=204)


@router.put("/security/document-scopes/{role_id}/{source_family}", status_code=status.HTTP_204_NO_CONTENT)
def update_scope(role_id: str, source_family: str, payload: ScopeGrantRequest, principal: AuthenticatedPrincipal = Depends(require("document_acl.manage")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.set_scope_grant(principal, role_id, source_family, payload.active)
    except SecurityError as exc:
        raise admin_error(exc, "Ámbito documental no válido") from None
    return Response(status_code=204)


@router.put("/security/document-exceptions/user/{account_id}/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def update_user_exception(account_id: UUID, document_id: str, payload: ExceptionRequest, principal: AuthenticatedPrincipal = Depends(require("document_acl.manage")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.set_document_exception(principal, account_id=account_id, role_id=None, document_id=document_id, decision=payload.decision, active=payload.active)
    except SecurityError as exc:
        raise admin_error(exc, "Excepción documental no válida") from None
    return Response(status_code=204)


@router.put("/security/document-exceptions/role/{role_id}/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def update_role_exception(role_id: str, document_id: str, payload: ExceptionRequest, principal: AuthenticatedPrincipal = Depends(require("document_acl.manage")), service: SecurityService = Depends(service_for)) -> Response:
    try:
        service.set_document_exception(principal, account_id=None, role_id=role_id, document_id=document_id, decision=payload.decision, active=payload.active)
    except SecurityError as exc:
        raise admin_error(exc, "Excepción documental no válida") from None
    return Response(status_code=204)
