"""Unidades locales de evidencia para vincular concepto y valor en Gate 3 (F-04).

Un valor del tipo pedido solo respalda la pregunta si aparece en la misma unidad
local que el atributo preguntado. La unidad se arma con la estructura que ya existe:

1. el bloque del fragmento (párrafo, renglón cerrado o cláusula con encabezado);
2. el encabezado inmediatamente anterior («Renta», «Cláusula 3», «Fecha») o el bloque de
   apertura del documento cuando precede inmediatamente al contenido;
3. la continuación del mismo bloque en el fragmento contiguo, solo si ambos fragmentos
   pertenecen a la misma versión, tienen ordinales consecutivos y el siguiente empieza con el
   traslape real que deja el fragmentador, antes de cualquier encabezado nuevo. Ese tramo es
   el mismo texto y, por construcción, la misma sección o cláusula. No se comparan las
   etiquetas de sección de los fragmentos: el fragmentador asigna la primera que contiene,
   no la vigente al inicio del fragmento.

Nunca se combinan bloques distantes del mismo documento.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Sequence

from app.rag.models import RankedFragment

_STRUCTURAL = re.compile(r"(?i)^(?:secci[oó]n|art[ií]culo|cl[aá]usula)\b")
_SENTENCE_END = (".", ";", "!", "?")
_MAX_HEADING_WORDS = 8
_MAX_HEADING_CHAIN = 2
_OVERLAP_PROBE = 40


@dataclass(frozen=True)
class _Block:
    text: str
    heading: bool


def _short(line: str) -> bool:
    """Renglón breve sin cierre de oración: rótulo o valor de formulario/tabla, no prosa."""
    return len(line.split()) <= _MAX_HEADING_WORDS and not line.endswith(_SENTENCE_END)


def _is_heading(text: str) -> bool:
    """Rótulo que da contexto al bloque siguiente; un renglón con cifras es un valor, no un rótulo."""
    return bool(_STRUCTURAL.match(text)) or text.endswith(":") or (_short(text) and not any(char.isdigit() for char in text))


def _blocks(text: str) -> list[_Block]:
    """Párrafos del fragmento; los renglones breves (rótulos y valores) son bloques propios."""
    groups: list[list[str]] = []
    current: list[str] = []
    for raw in text.splitlines():
        line = " ".join(raw.split())
        if not line:
            if current:
                groups.append(current)
                current = []
            continue
        if current and (_STRUCTURAL.match(line) or current[-1].endswith((*_SENTENCE_END, ":")) or _short(current[-1]) or _short(line)):
            groups.append(current)
            current = []
        current.append(line)
    if current:
        groups.append(current)
    return [_Block(" ".join(group), _is_heading(" ".join(group))) for group in groups]


def _normalized(text: str) -> str:
    return " ".join(text.split())


def _continues(previous: RankedFragment, following: RankedFragment) -> bool:
    """El fragmento siguiente continúa el bloque final del anterior (traslape del fragmentador)."""
    a, b = previous.citation, following.citation
    if a.document_version_id is None or a.document_version_id != b.document_version_id:
        return False
    if a.ordinal is None or b.ordinal != a.ordinal + 1:
        return False
    first = _blocks(following.fragment_text)
    if not first or _STRUCTURAL.match(first[0].text):
        return False
    head = _normalized(following.fragment_text)[:_OVERLAP_PROBE]
    return len(head) == _OVERLAP_PROBE and head in _normalized(previous.fragment_text)


def local_units(items: Sequence[RankedFragment]) -> list[str]:
    """Textos de las unidades locales construidas con los fragmentos relevantes de un documento."""
    blocks = {item.fragment_id: _blocks(item.fragment_text) for item in items}
    by_position = {(item.citation.document_version_id, item.citation.ordinal): item
                   for item in items if item.citation.document_version_id is not None and item.citation.ordinal is not None}

    def neighbour(item: RankedFragment, step: int) -> RankedFragment | None:
        version, ordinal = item.citation.document_version_id, item.citation.ordinal
        return None if version is None or ordinal is None else by_position.get((version, ordinal + step))

    def tagged(item: RankedFragment, upto: int | None = None) -> list[tuple[_Block, bool]]:
        """Bloques del fragmento, del más cercano al más lejano, marcando el bloque de apertura del documento."""
        own = blocks[item.fragment_id][:upto]
        return [(block, item.citation.ordinal == 0 and position == 0) for position, block in reversed(list(enumerate(own)))]

    units = []
    for item in items:
        own = blocks[item.fragment_id]
        previous_item, next_item = neighbour(item, -1), neighbour(item, 1)
        for index, block in enumerate(own):
            members = [block.text]
            predecessors = tagged(item, index)
            if index == 0 and previous_item is not None:
                earlier = tagged(previous_item)
                if _continues(previous_item, item):
                    # El mismo bloque quedó partido entre los dos fragmentos: forma una sola unidad.
                    members.insert(0, earlier[0][0].text)
                    earlier = earlier[1:]
                predecessors = earlier
            chain = 0
            # Un rótulo no toma como contexto a otro rótulo; solo un encabezado estructural
            # («Cláusula 3») puede preceder a un rótulo («Renta») del mismo bloque.
            for candidate, opening in ([] if block.heading else predecessors):
                if candidate.heading and chain < _MAX_HEADING_CHAIN and (chain == 0 or _STRUCTURAL.match(candidate.text)):
                    members.insert(0, candidate.text)
                    chain += 1
                    continue
                if opening:
                    # La apertura del documento solo acompaña a la unidad que sigue inmediatamente.
                    members.insert(0, candidate.text)
                break
            if index == len(own) - 1 and next_item is not None and _continues(item, next_item):
                members.append(blocks[next_item.fragment_id][0].text)
            units.append(" ".join(members))
    return units
