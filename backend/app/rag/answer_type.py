"""Tipo de información que exige la pregunta y su soporte material en la evidencia (Gate 3, F-04).

Solo se reconocen expresiones interrogativas de alta confianza (con su acentuación
interrogativa). Si la pregunta no exige un tipo reconocible no se impone ninguna
comprobación adicional. Las entidades nombradas localizan el contexto, pero no
sustituyen el concepto que se pregunta.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

QUANTITY, DATE, AMOUNT, DURATION, IDENTITY, LEGAL_BASIS = "QUANTITY", "DATE", "AMOUNT", "DURATION", "IDENTITY", "LEGAL_BASIS"

# «un/una» no cuentan como cifra: en español son sobre todo artículos.
_NUMBER_WORDS = (
    "dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|dieciseis|diecisiete|"
    "dieciocho|diecinueve|veinte|veinticinco|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|"
    "doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil|millón|millones"
)
_NUMBER = rf"(?:\d+(?:[.,]\d+)*|{_NUMBER_WORDS})"
_UNIT = r"(?:días?|mes(?:es)?|años?|horas?|semanas?|trimestres?)"
_MONTHS = r"(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)"

# El orden importa: «cuánto tiempo» y «cuántos días» son duración antes que monto o cantidad.
_DETECTORS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (LEGAL_BASIS, re.compile(r"\bqué (?:ley|leyes|norma|normas|normativa|regulación|legislación|jurisdicción|tribunales)\b"
                             r"|\b(?:ley|legislación|norma) aplicable\b")),
    (DURATION, re.compile(rf"\bqué plazo\b|\bcuánto tiempo\b|\bcuánto dura\w*|\bcuánt(?:os|as) {_UNIT}\b|\bdurante cuánto\b")),
    (DATE, re.compile(r"\bqué fecha\b|\bcuándo\b|\ben qué (?:mes|meses|día|año)\b")),
    (QUANTITY, re.compile(r"\bcuánt(?:os|as)\b|\bnúmero de\b|\bcantidad de\b")),
    (AMOUNT, re.compile(r"\bcuánto\b|\bmonto\b|\bimporte\b")),
    (IDENTITY, re.compile(r"\bquién(?:es)?\b|\bqué parte\b")),
)

_LEGAL_BASIS_EVIDENCE = re.compile(
    r"\b(?:ley|leyes|legislación|norma|normas|normativa|regulación|reglamento|código|jurisdicción|tribunales)\b|\bregirá\b|\bse rige\b"
)
# «¿Qué fecha…?» pide una fecha de calendario; «¿Cuándo…?» admite además un momento relativo
# («dentro de los primeros cinco días de cada mes»).
_CALENDAR_DATE = re.compile(rf"\b\d{{1,2}}/\d{{1,2}}/\d{{2,4}}\b|\b\d{{4}}-\d{{2}}-\d{{2}}\b|\b{_MONTHS}\b|\bdía {_NUMBER}\b")
_RELATIVE_TIME = re.compile(rf"\b{_NUMBER} (?:primeros )?{_UNIT}\b|\b(?:primeros|últimos) {_NUMBER} {_UNIT}\b")
_DURATION_EVIDENCE = re.compile(
    rf"\b{_NUMBER}(?: y {_NUMBER})? {_UNIT}\b|\b{_UNIT} {_NUMBER}\b|\btrimestral(?:es)?\b|\bmensual(?:es)?\b|\banual(?:es)?\b"
)
# Un monto es una cifra monetaria o un porcentaje, no cualquier número del texto.
_AMOUNT_EVIDENCE = re.compile(
    rf"\$\s?\d|\b{_NUMBER}(?:\s+\w+){{0,3}}\s+(?:pesos|dólares|euros|mxn|usd)\b|\b(?:uno|{_NUMBER}) por ciento\b|\d\s?%"
)
_ROLE_EVIDENCE = re.compile(
    r"\b(?:director|directora|gerente|arrendador|arrendatario|prestador|actor|demandada|juzgado|tribunal|autoridad|comité|contraloría)\b"
)
# Dos o más palabras con mayúscula inicial que no abren oración (p. ej. «Inmobiliaria Beta»).
_PROPER_NAME = re.compile(r"(?<![.¿?!]\s)(?<!^)\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+")


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def detect_answer_type(query: str) -> str | None:
    """Tipo exigido por la pregunta, solo con expresiones de alta confianza; None si no se reconoce."""
    folded = _fold(query)
    for kind, pattern in _DETECTORS:
        if pattern.search(folded):
            return kind
    return None


def counted_noun(query: str) -> str | None:
    """Sustantivo contado en «cuántos X», «número de X» o «cantidad de X»."""
    match = re.search(r"\b(?:cuánt(?:os|as)|número de|cantidad de)\s+(\w+)", _fold(query))
    return match.group(1) if match else None


def supports_answer_type(kind: str | None, query: str, texts: Iterable[str]) -> bool:
    """La evidencia contiene soporte material compatible con el tipo de respuesta solicitado."""
    if kind is None:
        return True
    texts = list(texts)
    corpus = " ".join(_fold(text) for text in texts)
    if kind == QUANTITY:
        noun = counted_noun(query)
        if noun is None:
            return bool(re.search(rf"\b{_NUMBER}\b", corpus))
        # La cifra debe acompañar a lo que se cuenta (hasta dos palabras intermedias), no aparecer en cualquier parte.
        stem = re.escape(noun[:5] if len(noun) > 5 else noun)
        return bool(re.search(rf"\b{_NUMBER}(?:\s+\w+){{0,2}}\s+{stem}\w*", corpus))
    if kind == DURATION:
        return bool(_DURATION_EVIDENCE.search(corpus))
    if kind == DATE:
        relative = "cuándo" in _fold(query)
        return bool(_CALENDAR_DATE.search(corpus) or (relative and _RELATIVE_TIME.search(corpus)))
    if kind == AMOUNT:
        return bool(_AMOUNT_EVIDENCE.search(corpus))
    if kind == IDENTITY:
        return bool(_ROLE_EVIDENCE.search(corpus) or _PROPER_NAME.search(" ".join(texts)))
    if kind == LEGAL_BASIS:
        return bool(_LEGAL_BASIS_EVIDENCE.search(corpus))
    return True


def entity_terms(query: str) -> set[str]:
    """Términos escritos como nombre propio en la pregunta (mayúscula inicial fuera del inicio de la oración)."""
    text = query.strip()
    terms = set()
    for match in re.finditer(r"(?<!\w)([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)", text):
        previous = text[:match.start(1)].rstrip()
        if previous and previous[-1] not in "¿¡.?!:":
            terms.add(_fold(match.group(1)))
    return terms
