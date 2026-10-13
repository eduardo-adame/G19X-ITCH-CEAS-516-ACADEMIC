"""SRS_REQUIRED: contrato HTTP, autenticación y errores seguros del visor."""
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.documents.viewer_api import router, viewer_service_for
from app.documents.viewer_models import ViewerNotFound, ViewerVersionChanged, ViewerUnavailable
from app.security.api import current_principal
from app.security.models import AuditPersistenceError, AuthenticationError, AuthorizationError


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router, prefix="/api/documents")
    return TestClient(app)


def test_direct_unauthenticated_all_viewer_routes_are_denied_without_cache(client):
    for path in ["/api/documents/viewer", "/api/documents/viewer/id", "/api/documents/viewer/id/original?version_id=" + str(uuid4())]:
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"


class Service:
    error = None
    def catalog(self, query, principal):
        if self.error: raise self.error
        return {"items": [], "next_cursor": None}
    def read(self, *args, **kwargs):
        if self.error: raise self.error
        return b"%PDF-1.7\nsynthetic"


def authorized(client):
    service = Service()
    client.app.dependency_overrides[current_principal] = lambda: object()
    client.app.dependency_overrides[viewer_service_for] = lambda: service
    return service


@pytest.mark.parametrize("exception, status", [(AuditPersistenceError, 503), (ViewerUnavailable, 503),
    (ViewerNotFound, 404), (ViewerVersionChanged, 409), (AuthenticationError, 401),
    (AuthorizationError, 403), (ValueError, 422)])
def test_api_safe_errors_contain_no_internal_exception_body(client, exception, status):
    service = authorized(client)
    service.error = exception("internal sensitive sentinel")
    response = client.get("/api/documents/viewer/id")
    assert response.status_code == status and "sentinel" not in response.text
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("query", ["q=" + "x" * 201, "limit=0", "limit=101", "document_type=HTML", "source_family=UNKNOWN", "cursor=" + "x" * 2049])
def test_invalid_query_returns_sanitized_422_without_input_echo(client, query):
    authorized(client)
    response = client.get("/api/documents/viewer?" + query)
    assert response.status_code == 422
    assert response.json() == {"detail": "Parámetros no válidos"}


def test_original_is_authenticated_inline_pdf_and_version_is_required(client):
    authorized(client)
    assert client.get("/api/documents/viewer/id/original").status_code == 422
    response = client.get("/api/documents/viewer/id/original?version_id=" + str(uuid4()))
    assert response.status_code == 200 and response.content.startswith(b"%PDF-")
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'inline; filename="document.pdf"'
