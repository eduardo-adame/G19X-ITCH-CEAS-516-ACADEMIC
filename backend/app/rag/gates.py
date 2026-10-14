"""Gates de política, relevancia y soporte material de la consulta RAG.

Gate 1 identifica solicitudes de decisión jurídica autónoma antes de recuperar
documentos. Gate 2 exige similitud semántica calibrada con la evidencia. Gate 3
exige que los conceptos centrales de la consulta estén respaldados por los
fragmentos citados de un mismo documento y, cuando la pregunta pide un tipo de
dato reconocible (cantidad, fecha, monto, plazo, identidad o base normativa), que
un valor de ese tipo aparezca en la misma unidad local que el atributo preguntado.

Los gates locales solo descartan: Estado 3 (sin evidencia relevante) o Estado 2
(insuficiencia evidente). Lo que los supera es candidato a generación y el Estado 1
se decide después de validar la respuesta sustentada del proveedor. La configuración
y el clasificador están congelados y versionados en ``gates_data``; el runtime no
los reentrena.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
import json
import math
from pathlib import Path
import re
from typing import Callable, Mapping, Sequence
import unicodedata
from uuid import UUID

from app.rag.answer_type import detect_answer_type, entity_terms, supports_answer_type
from app.rag.evidence_locality import local_units
from app.rag.lexical import lexical_term_frequencies
from app.rag.models import EvidenceState, ProcessingOutcome, RankedFragment

_DATA = Path(__file__).with_name("gates_data")
_DIMENSIONS = 1024


@dataclass(frozen=True)
class DecisionProbe:
    """Regresión logística congelada sobre el embedding normalizado de la consulta."""

    version: str
    threshold: float
    intercept: float
    coefficients: tuple[float, ...]

    def probability(self, vector: Sequence[float]) -> float:
        unit = _unit(vector)
        score = self.intercept + sum(weight * value for weight, value in zip(self.coefficients, unit))
        return 1.0 / (1.0 + math.exp(-score))


@dataclass(frozen=True)
class GatesConfig:
    version: str
    policy_patterns: tuple[re.Pattern[str], ...]
    probe: DecisionProbe
    relevance_min_cosine: float
    central_term_ratio: float
    stem_prefix: int
    min_term_length: int
    stopwords: frozenset[str]
    answer_type_support: bool
    entity_requires_concept: bool
    concept_value_binding: bool


def _unit(vector: Sequence[float]) -> list[float]:
    values = [float(value) for value in vector]
    length = math.sqrt(sum(value * value for value in values))
    if len(values) != _DIMENSIONS or not math.isfinite(length) or length == 0.0:
        raise ValueError("embedding de consulta no válido")
    return [value / length for value in values]


@lru_cache(maxsize=1)
def gates_config() -> GatesConfig:
    raw = json.loads((_DATA / "gates_config_v4.json").read_text(encoding="utf-8"))
    model = json.loads((_DATA / raw["gate1"]["decision_probe"]).read_text(encoding="utf-8"))
    coefficients = tuple(float(value) for value in model["coefficients"])
    threshold = float(model["threshold"])
    if (len(coefficients) != _DIMENSIONS or not all(math.isfinite(value) for value in coefficients)
            or not 0.0 < threshold < 1.0 or model.get("normalization") != "l2_unit"):
        raise RuntimeError("clasificador de política no válido")
    relevance, ratio = float(raw["gate2"]["relevance_min_cosine"]), float(raw["gate3"]["central_term_ratio"])
    if not (0.0 < relevance < 1.0 and 0.0 < ratio <= 1.0):
        raise RuntimeError("configuración de gates no válida")
    return GatesConfig(
        version=raw["version"],
        policy_patterns=tuple(re.compile(pattern) for pattern in raw["gate1"]["policy_patterns"]),
        probe=DecisionProbe(model["version"], threshold, float(model["intercept"]), coefficients),
        relevance_min_cosine=relevance,
        central_term_ratio=ratio,
        stem_prefix=int(raw["gate3"]["stem_prefix"]),
        min_term_length=int(raw["gate3"]["min_term_length"]),
        stopwords=frozenset(raw["gate3"]["stopwords"]),
        answer_type_support=bool(raw["gate3"].get("answer_type_support", False)),
        entity_requires_concept=bool(raw["gate3"].get("entity_requires_concept", False)),
        concept_value_binding=bool(raw["gate3"].get("concept_value_binding", False)),
    )


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def _stem(term: str, prefix: int) -> str:
    return term[:prefix] if len(term) > prefix else term


def salient_terms(query: str, config: GatesConfig | None = None) -> list[str]:
    config = config or gates_config()
    terms = (item.normalized_lexeme for item in lexical_term_frequencies(query))
    return list(dict.fromkeys(t for t in terms if t not in config.stopwords and len(t) >= config.min_term_length))


def is_decision_request(query: str, query_vector: Sequence[float], config: GatesConfig | None = None) -> bool:
    """Gate 1: patrones de decisión dirigida al sistema o clasificador congelado (umbral conservador)."""
    config = config or gates_config()
    folded = _fold(query)
    if any(pattern.search(folded) for pattern in config.policy_patterns):
        return True
    return config.probe.probability(query_vector) >= config.probe.threshold


def term_importance(query: str, query_vector: Sequence[float], encode: Callable[[str], Sequence[float]],
                    config: GatesConfig | None = None) -> dict[str, float]:
    """Importancia semántica de cada término: 1 − coseno(consulta, consulta sin el término)."""
    config = config or gates_config()
    full = _unit(query_vector)
    folded = _fold(query)
    importance: dict[str, float] = {}
    for term in salient_terms(query, config):
        ablated = re.sub(rf"(?<!\w){re.escape(term)}(?!\w)", " ", folded)
        if ablated.strip() == folded.strip() or not ablated.strip():
            continue
        reduced = _unit(encode(ablated))
        importance[term] = 1.0 - sum(a * b for a, b in zip(full, reduced))
    return importance


def central_terms(importance: Mapping[str, float], config: GatesConfig | None = None) -> list[str]:
    config = config or gates_config()
    if not importance:
        return []
    peak = max(importance.values())
    return [term for term, value in importance.items() if value >= config.central_term_ratio * peak]


def _with_requested_concept(query: str, central: list[str], importance: Mapping[str, float], config: GatesConfig) -> list[str]:
    """Una entidad nombrada localiza el contexto, pero no sustituye al concepto preguntado.

    Si todos los conceptos centrales son nombres propios de la consulta, se exige además
    el término no nominal más importante (o el primero, si no hubo ablación).
    """
    entities = entity_terms(query)
    if not central or not all(term in entities for term in central):
        return central
    others = [term for term in salient_terms(query, config) if term not in entities]
    if not others:
        return central
    requested = max(others, key=lambda term: importance.get(term, -1.0))
    return [*central, requested]


def _typed_support(answer_type: str | None, query: str, central: Sequence[str], items: Sequence[RankedFragment],
                   config: GatesConfig) -> bool:
    """El valor del tipo pedido debe estar vinculado localmente al atributo preguntado.

    Las entidades nombradas localizan el documento y pueden estar en cualquier fragmento
    relevante; los demás conceptos centrales deben compartir unidad local con el valor.
    """
    if answer_type is None:
        return True
    if not config.concept_value_binding:
        return supports_answer_type(answer_type, query, (item.fragment_text for item in items))
    entities = entity_terms(query)
    attribute = {_stem(term, config.stem_prefix) for term in central if term not in entities}
    for unit in local_units(items):
        stems = {_stem(t.normalized_lexeme, config.stem_prefix) for t in lexical_term_frequencies(unit)}
        if attribute <= stems and supports_answer_type(answer_type, query, [unit]):
            return True
    return False


def gated_evidence_state(
    query: str,
    query_vector: Sequence[float],
    fragments: Sequence[RankedFragment],
    cosines: Mapping[UUID, float],
    encode: Callable[[str], Sequence[float]],
    config: GatesConfig | None = None,
) -> EvidenceState | ProcessingOutcome:
    """Gates 2 y 3 sobre los fragmentos finales autorizados; nunca devuelve Estado 1."""
    config = config or gates_config()
    relevant = [item for item in fragments if cosines.get(item.fragment_id, -1.0) >= config.relevance_min_cosine]
    if not relevant:
        return EvidenceState.SIN_EVIDENCIA
    importance = term_importance(query, query_vector, encode, config)
    # Con un único término saliente no hay ablación posible: ese término es el concepto central.
    central = central_terms(importance, config) or salient_terms(query, config)
    if config.entity_requires_concept:
        central = _with_requested_concept(query, central, importance, config)
    answer_type = detect_answer_type(query) if config.answer_type_support else None
    by_document: dict[str, list[RankedFragment]] = defaultdict(list)
    for item in relevant:
        by_document[item.document_id].append(item)
    any_support = False
    for items in by_document.values():
        stems = {_stem(t.normalized_lexeme, config.stem_prefix) for item in items for t in lexical_term_frequencies(item.fragment_text)}
        covered = [term for term in central if _stem(term, config.stem_prefix) in stems]
        any_support = any_support or bool(covered)
        qualifies = any(
            item.citation.complete and ((item.vector_rank is not None and item.vector_rank <= 3)
                                        or (item.bm25_rank is not None and item.bm25_rank <= 3))
            for item in items
        )
        typed = _typed_support(answer_type, query, central, items, config)
        if central and len(covered) == len(central) and qualifies and typed:
            return ProcessingOutcome.GENERATION_CANDIDATE
    return EvidenceState.EVIDENCIA_INSUFICIENTE if any_support else EvidenceState.SIN_EVIDENCIA
