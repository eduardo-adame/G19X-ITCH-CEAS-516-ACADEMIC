"""Confianza OCR por palabra (RF-020, RF-026): agregación documental y conservación de valores."""
from __future__ import annotations

import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.documents.processing import _document_confidence
from app.documents.repository import DocumentsRepository
from app.ocr.consolidation import NativePage, consolidate
from app.ocr.engine import TesseractOcrEngine


def test_srs_required_engine_returns_the_valid_word_confidences_it_aggregates(monkeypatch) -> None:
    data = {"text": ["Cláusula", "", "primera", "ruido", "  "], "conf": ["91", "-1", "83", "-1", "40"]}
    fake = SimpleNamespace(image_to_data=lambda *_args, **_kwargs: data, Output=SimpleNamespace(DICT="dict"))
    monkeypatch.setitem(sys.modules, "pytesseract", fake)
    result = TesseractOcrEngine().recognize(object(), page_number=1)
    assert result.samples == (0.91, 0.83)
    assert result.confidence == pytest.approx(0.87)
    assert result.granularity == "WORD"


def test_srs_required_document_confidence_averages_words_not_page_averages() -> None:
    # Página 1: 390 palabras con 0.956; página 2: 6 palabras con 0.331 (medición real de la certificación).
    pages = [("texto", 0.956, (0.956,) * 390), ("anexo", 0.331, (0.331,) * 6)]
    aggregate, granularity, samples = _document_confidence(pages)
    assert aggregate == pytest.approx((390 * 0.956 + 6 * 0.331) / 396)
    assert aggregate >= 0.80
    assert granularity == "WORD" and len(samples) == 396


def test_srs_required_absent_word_confidences_are_not_zero() -> None:
    aggregate, granularity, samples = _document_confidence([("", None, ())])
    assert aggregate is None and granularity == "WORD" and samples == ()


def test_robustness_page_level_engines_keep_their_page_granularity() -> None:
    aggregate, granularity, samples = _document_confidence([("a", 0.9, ), ("b", 0.7)])
    assert aggregate == pytest.approx(0.8) and granularity == "PAGE" and samples == ()


def test_robustness_consolidation_accepts_pages_with_word_confidences() -> None:
    pages = [NativePage(1, "Texto nativo", False), NativePage(2, "", True)]
    consolidated = consolidate(pages, {2: ("Texto reconocido", 0.93, (0.93,))})
    assert consolidated.text == "Texto nativo\n\nTexto reconocido"


class _Cursor:
    def __init__(self, sink):
        self.sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def executemany(self, sql, rows):
        self.sink.append((sql, rows))


class _Connection:
    def __init__(self):
        self.statements = []
        self.many = []
        self.run_id = uuid4()

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return SimpleNamespace(fetchone=lambda: {"id": self.run_id})

    def cursor(self):
        return _Cursor(self.many)


def _insert(connection, samples):
    DocumentsRepository.insert_ocr_run(
        connection, document_version_id=uuid4(), attempt_number=1, estado_ocr="Exitoso",
        confianza_agregada=0.9, total_page_count=1, processed_page_count=1, granularity="WORD",
        operation_id=uuid4(), correlation_id=uuid4(), samples=samples,
    )


def test_srs_required_ocr_run_keeps_each_word_confidence_in_order() -> None:
    connection = _Connection()
    _insert(connection, (0.91, 0.83))
    assert "RETURNING id" in connection.statements[0][0]
    sql, rows = connection.many[0]
    assert "app.ocr_confidence_sample" in sql
    assert rows == [(connection.run_id, 1, "WORD", 0.91), (connection.run_id, 2, "WORD", 0.83)]


def test_robustness_ocr_run_without_samples_writes_no_sample_rows() -> None:
    connection = _Connection()
    _insert(connection, ())
    assert connection.many == []
