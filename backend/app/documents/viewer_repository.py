"""Lecturas documentales recortadas antes de seleccionar metadatos o contenido."""
from __future__ import annotations


_FROM = """
 FROM app.document d
 JOIN app.document_version v ON v.id = d.active_version_id AND v.id_documento = d.id_documento
 JOIN app.stored_object s ON s.id = v.stored_object_id
 JOIN app.ingest_file f ON f.id::text = d.id_documento AND f.stored_object_id = s.id
 JOIN app.document_candidate c ON c.ingest_file_id = f.id
 WHERE d.invalidated_at IS NULL AND v.processing_state = 'LISTA'
   AND d.document_type IN ('PDF', 'DOCX')
   AND f.exchange_format = d.document_type AND f.detected_format = d.document_type
   AND f.source_family = d.source_family
   AND f.state = 'COMPLETADO' AND f.technical_result = 'ACCEPTED'
   AND (v.source_record_id IS NULL OR EXISTS (
       SELECT 1 FROM app.source_record r WHERE r.id = v.source_record_id AND r.ingest_file_id = f.id))
   AND NOT EXISTS (SELECT 1 FROM app.quarantine_item q
       WHERE q.ingest_file_id = f.id AND q.state = 'Pendiente')
"""
_METADATA = """
 d.id_documento AS document_id, v.id AS document_version_id, v.version_number,
 d.name AS document_name, d.document_type, d.source_family, d.document_date,
 CASE WHEN d.document_type = 'PDF' THEN 'PDF_ORIGINAL' ELSE 'CONSOLIDATED_TEXT' END AS representation,
 (v.consolidated_text IS NOT NULL AND btrim(v.consolidated_text) <> '') AS text_available,
 v.created_at
"""


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class ViewerRepository:
    def __init__(self, security_repository):
        self.security_repository = security_repository

    def transaction(self):
        return self.security_repository.transaction()

    @staticmethod
    def catalog(connection, scope, query, after=None):
        predicate, params = scope.database_predicate("d")
        clauses = [predicate]
        if query.q is not None:
            clauses.append("d.name ILIKE %(name)s ESCAPE E'\\\\'")
            params["name"] = "%" + escape_like(query.q) + "%"
        for field in ("source_family", "document_type"):
            value = getattr(query, field)
            if value is not None:
                clauses.append(f"d.{field} = %({field})s")
                params[field] = value
        if after is not None:
            clauses.append("(v.created_at, v.id) < (%(after_stamp)s, %(after_id)s)")
            params["after_stamp"], params["after_id"] = after
        params["page_limit"] = query.limit + 1
        return connection.execute(
            "SELECT " + _METADATA + _FROM + " AND " + " AND ".join(clauses)
            + " ORDER BY v.created_at DESC, v.id DESC LIMIT %(page_limit)s", params,
        ).fetchall()

    @staticmethod
    def content(connection, scope, document_id):
        predicate, params = scope.database_predicate("d")
        params["document_id"] = document_id
        # El lock de documento ordena sustituciones; archivo y objeto protegen la procedencia.
        row = connection.execute(
            "SELECT " + _METADATA + ", v.consolidated_text AS text, s.locator, s.sha256, s.byte_size, s.mime_type,"
            + " f.id AS ingest_file_id, v.source_record_id"
            + _FROM + " AND " + predicate + " AND d.id_documento = %(document_id)s"
            + " FOR SHARE OF d, v, s, c FOR UPDATE OF f", params,
        ).fetchone()
        if row is not None:
            # UPDATE del archivo bloquea altas por FK; estas filas compartidas bloquean cambios de estado existentes.
            connection.execute("SELECT id FROM app.quarantine_item WHERE ingest_file_id = %s FOR SHARE",
                               (row["ingest_file_id"],)).fetchall()
            if row["source_record_id"] is not None:
                connection.execute("SELECT id FROM app.source_record WHERE id = %s FOR SHARE",
                                   (row["source_record_id"],)).fetchall()
        return row
