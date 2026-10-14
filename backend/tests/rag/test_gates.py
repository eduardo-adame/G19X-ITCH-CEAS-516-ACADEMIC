"""Gates de política, relevancia y soporte material (F-04, SRS v0.23)."""
from __future__ import annotations

from datetime import date
from uuid import uuid4

import pytest

from app.rag import answer_type, gates
from app.rag.evidence_locality import local_units
from app.rag.models import CitationMetadata, EvidenceState, ProcessingOutcome, RankedFragment


def _fragment(text, *, document="DOC-A", vector_rank=1, bm25_rank=None, complete=True, version=None, ordinal=None, section=None, clause=None):
    identity = uuid4()
    citation = CitationMetadata(document_id=document, document_name=document, document_type="PDF",
                                document_date=date(2026, 1, 1) if complete else None, fragment_id=identity,
                                section=section, clause=clause, document_version_id=version, ordinal=ordinal)
    return RankedFragment(identity, document, text, citation, vector_rank, bm25_rank, 0)


@pytest.fixture
def central(monkeypatch):
    """Fija la importancia semántica para aislar Gate 3 del modelo de embeddings."""
    def apply(importance):
        monkeypatch.setattr(gates, "term_importance", lambda *_args, **_kwargs: importance)
    return apply


VECTOR = tuple([1.0] * 1024)


@pytest.mark.contract
def test_configuracion_congelada_y_versionada() -> None:
    config = gates.gates_config()
    assert config.version == "rag-gates-v4" and config.probe.version == "decision-probe-v2"
    assert config.probe.threshold == 0.45 and len(config.probe.coefficients) == 1024
    assert config.relevance_min_cosine == 0.47 and config.central_term_ratio == 0.45
    assert {"documentos", "evidencia", "mencionan", "deben"} <= config.stopwords
    assert config.answer_type_support and config.entity_requires_concept and config.concept_value_binding


@pytest.mark.contract
@pytest.mark.parametrize("query", ["Decide si debo demandar al proveedor Alfa", "¿Es buena idea firmar el contrato?",
                                   "Toma una decisión jurídica por mí", "¿Debemos rescindir el contrato Delta?"])
def test_gate1_patrones_de_decision_dirigida_al_sistema(query) -> None:
    opposite = tuple(-value for value in gates.gates_config().probe.coefficients)
    assert gates.is_decision_request(query, opposite)


@pytest.mark.contract
def test_gate1_clasificador_congelado_aplica_umbral_conservador() -> None:
    probe = gates.gates_config().probe
    aligned, opposite = probe.coefficients, tuple(-value for value in probe.coefficients)
    assert probe.probability(aligned) > 0.99 and probe.probability(opposite) < 0.01
    # «debemos» informativo ya no activa un patrón: solo decide el clasificador.
    assert not gates.is_decision_request("¿Qué obligaciones debemos cumplir antes de noviembre?", opposite)
    assert gates.is_decision_request("¿Qué obligaciones debemos cumplir antes de noviembre?", aligned)


@pytest.mark.contract
def test_gate1_rechaza_embedding_invalido() -> None:
    with pytest.raises(ValueError):
        gates.gates_config().probe.probability((0.0,) * 1024)


@pytest.mark.contract
def test_gate2_sin_fragmento_relevante_es_sin_evidencia(central) -> None:
    central({"penalización": 0.2})
    item = _fragment("Penalización por retraso")
    state = gates.gated_evidence_state("¿Cuál es la penalización?", VECTOR, [item], {item.fragment_id: 0.30}, lambda _t: VECTOR)
    assert state is EvidenceState.SIN_EVIDENCIA


@pytest.mark.contract
def test_gate3_conceptos_centrales_respaldados_en_un_documento_es_suficiente(central) -> None:
    central({"visitas": 0.20, "delta": 0.15, "frecuencia": 0.05})
    header, answer = _fragment("Contrato Delta de mantenimiento"), _fragment("El prestador realizará visitas trimestrales", vector_rank=2)
    cos = {header.fragment_id: 0.62, answer.fragment_id: 0.53}
    assert gates.gated_evidence_state("¿Con qué frecuencia son las visitas del contrato Delta?", VECTOR, [header, answer], cos, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE


@pytest.mark.contract
def test_gate3_concepto_central_sin_respaldo_es_insuficiente(central) -> None:
    """N05: la evidencia menciona al director general pero no el salario."""
    central({"director": 0.155, "general": 0.105, "salario": 0.098, "trabajo": 0.027})
    item = _fragment("Contratos superiores a un millón requieren la firma del director general")
    state = gates.gated_evidence_state("¿Cuál es el salario del director general?", VECTOR, [item], {item.fragment_id: 0.555}, lambda _t: VECTOR)
    assert state is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_gate3_respaldo_repartido_entre_documentos_distintos_no_es_suficiente(central) -> None:
    """TN10: la penalización pertenece a otro contrato; el tema solo coincide."""
    central({"penalización": 0.2, "gamma": 0.18})
    gamma = _fragment("Acuerdo de confidencialidad Gamma", document="GAMMA")
    alfa = _fragment("Penalización por retraso en la entrega", document="ALFA", vector_rank=2)
    cos = {gamma.fragment_id: 0.477, alfa.fragment_id: 0.476}
    assert gates.gated_evidence_state("¿Penalización por terminación del acuerdo Gamma?", VECTOR, [gamma, alfa], cos, lambda _t: VECTOR) is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_gate3_sin_ningun_concepto_respaldado_es_sin_evidencia(central) -> None:
    central({"lista": 0.08, "semana": 0.07})
    item = _fragment("Informe de auditoría de compras")
    assert gates.gated_evidence_state("Hazme una lista para la semana", VECTOR, [item], {item.fragment_id: 0.58}, lambda _t: VECTOR) is EvidenceState.SIN_EVIDENCIA


@pytest.mark.contract
def test_gate3_cita_incompleta_no_sustenta_estado_1(central) -> None:
    central({"visitas": 0.2})
    item = _fragment("visitas trimestrales", complete=False)
    assert gates.gated_evidence_state("¿Cuántas visitas?", VECTOR, [item], {item.fragment_id: 0.8}, lambda _t: VECTOR) is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_importancia_por_ablacion_usa_el_mismo_codificador() -> None:
    calls = []

    def encode(text):
        calls.append(text)
        return [1.0] + [0.0] * 1023 if "penalización" in text else [0.0, 1.0] + [0.0] * 1022

    importance = gates.term_importance("¿Cuál es la penalización del contrato?", [1.0] + [0.0] * 1023, encode)
    assert set(importance) == {"penalización", "contrato"}
    assert importance["penalización"] == pytest.approx(1.0) and importance["contrato"] == pytest.approx(0.0)


@pytest.mark.contract
@pytest.mark.parametrize("query", ["¿Procede que la empresa firme sin revisar el anexo?", "¿Debería la empresa aceptar las condiciones del proveedor Alfa?"])
def test_gate1_formulaciones_ampliadas_de_decision(query) -> None:
    opposite = tuple(-value for value in gates.gates_config().probe.coefficients)
    assert gates.is_decision_request(query, opposite)


@pytest.mark.contract
def test_regresion_cn15_metodo_de_pago_no_es_estado_1(monkeypatch) -> None:
    """CN15 (confirmación 1): la evidencia de Beta habla de la renta y su plazo, no del método de pago."""
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: {"arrendamiento": 0.1153, "beta": 0.1494, "método": 0.0793, "pactó": 0.075, "pago": 0.0594, "renta": 0.0487})
    header = _fragment("Contrato de arrendamiento Beta sobre la bodega ubicada en el Parque Industrial Ficticio, nave 7. Arrendador: Inmobiliaria Beta.", document="BETA")
    rent = _fragment("Renta: el arrendatario pagará una renta mensual de ochenta mil pesos más IVA dentro de los primeros cinco días de cada mes.", document="BETA", vector_rank=2, bm25_rank=2)
    deposit = _fragment("Depósito en garantía: el arrendatario entrega un depósito equivalente a dos meses de renta.", document="BETA", vector_rank=3)
    cos = {header.fragment_id: 0.537, rent.fragment_id: 0.517, deposit.fragment_id: 0.46}
    state = gates.gated_evidence_state("¿Qué método de pago se pactó para la renta en el arrendamiento Beta?", VECTOR, [header, rent, deposit], cos, lambda _t: VECTOR)
    assert state is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_vocabulario_de_peticion_no_es_concepto_a_respaldar(central) -> None:
    """«¿Qué documentos mencionan…?»: se respalda el contenido pedido, no las palabras que enmarcan la petición."""
    central({"depósito": 0.2, "garantía": 0.15, "bodega": 0.1})
    item = _fragment("Depósito en garantía equivalente a dos meses de renta de la bodega")
    assert set(gates.salient_terms("¿Qué documentos mencionan el depósito en garantía de la bodega?")) == {"depósito", "garantía", "bodega"}
    assert gates.gated_evidence_state("¿Qué documentos mencionan el depósito en garantía de la bodega?", VECTOR, [item], {item.fragment_id: 0.6}, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE


# --- Tipo de respuesta (R-3) y entidades (R-2): la relevancia no equivale a capacidad de respuesta ---

AUDIT_FINDINGS = ("Hallazgos: se identificaron órdenes de compra emitidas después de recibir la factura, proveedores dados de alta sin "
                  "validación de documentos fiscales y ausencia de tres cotizaciones en compras mayores a quinientos mil pesos.")
BETA_HEADER = ("Contrato de arrendamiento Beta sobre la bodega ubicada en el Parque Industrial Ficticio, nave 7. Arrendador: "
               "Inmobiliaria Beta. Arrendatario: Industrias Ficticias Norte.")
BETA_RENT = ("Renta: el arrendatario pagará una renta mensual de ochenta mil pesos más IVA dentro de los primeros cinco días de cada mes. "
             "La renta se actualizará anualmente conforme al índice nacional de precios al consumidor.")
BETA_TERM = ("Vigencia: el arrendamiento tendrá una duración de tres años forzosos contados a partir de la entrega de la bodega, con opción "
             "de prórroga por dos años adicionales.")


@pytest.mark.contract
@pytest.mark.parametrize(("query", "expected"), [
    ("¿Cuántos proveedores existen?", answer_type.QUANTITY),
    ("¿Cuál es el número de cotizaciones exigidas?", answer_type.QUANTITY),
    ("¿Qué fecha tiene el acta?", answer_type.DATE),
    ("¿Cuándo vence la declaración anual?", answer_type.DATE),
    ("¿Cuánto paga el arrendatario de renta?", answer_type.AMOUNT),
    ("¿Cuál es el monto de la pena convencional?", answer_type.AMOUNT),
    ("¿Qué plazo tiene el proveedor para entregar?", answer_type.DURATION),
    ("¿Cuánto tiempo dura el arrendamiento?", answer_type.DURATION),
    ("¿Cuántos días de anticipación exige el aviso?", answer_type.DURATION),
    ("¿Quién firma los contratos superiores a un millón?", answer_type.IDENTITY),
    ("¿Qué parte asume el mantenimiento?", answer_type.IDENTITY),
    ("¿Qué ley rige el contrato?", answer_type.LEGAL_BASIS),
    ("¿Cuál es la legislación aplicable al acuerdo?", answer_type.LEGAL_BASIS),
    ("¿Qué jurisdicción se pactó?", answer_type.LEGAL_BASIS),
    ("¿Con qué frecuencia son las visitas?", None),
    ("Resume las obligaciones del proveedor", None),
    ("En cuanto a la renta, ¿qué dice el contrato?", None),
])
def test_tipo_de_respuesta_solo_con_expresiones_de_alta_confianza(query, expected) -> None:
    assert answer_type.detect_answer_type(query) == expected


@pytest.mark.contract
def test_soporte_de_tipo_exige_un_valor_compatible() -> None:
    support = answer_type.supports_answer_type
    assert not support(answer_type.QUANTITY, "¿Cuántos proveedores existen?", ["Los proveedores deberán entregar su constancia."])
    assert not support(answer_type.QUANTITY, "¿Cuántos proveedores fueron dados de alta?", [AUDIT_FINDINGS])
    assert support(answer_type.QUANTITY, "¿Cuántas cotizaciones se exigen?", [AUDIT_FINDINGS])
    assert support(answer_type.QUANTITY, "¿Cuántos proveedores se revisaron?", ["Se revisaron 14 proveedores activos."])
    assert support(answer_type.AMOUNT, "¿Cuánto es la renta?", [BETA_RENT])
    assert not support(answer_type.AMOUNT, "¿Cuál es el monto del depósito?", ["El depósito se devuelve al término del contrato."])
    assert support(answer_type.DURATION, "¿Cuánto tiempo dura?", [BETA_TERM])
    assert not support(answer_type.DURATION, "¿Qué plazo tiene?", [BETA_HEADER])
    assert support(answer_type.DATE, "¿Qué fecha tiene el acta?", ["Fecha del documento: 06/10/2026"])
    assert support(answer_type.DATE, "¿Cuándo se paga la renta?", [BETA_RENT])
    assert not support(answer_type.DATE, "¿Cuándo se firmó?", ["El acuerdo fue firmado por ambas partes."])
    assert support(answer_type.IDENTITY, "¿Quién es el arrendador?", [BETA_HEADER])
    assert not support(answer_type.IDENTITY, "¿Quién aprueba el pago?", ["el pago se aprueba tras la revisión del expediente."])
    assert support(answer_type.LEGAL_BASIS, "¿Qué ley rige?", ["El contrato se regirá por las leyes federales y los tribunales competentes."])
    assert not support(answer_type.LEGAL_BASIS, "¿Qué ley rige el contrato de arrendamiento Beta?", [BETA_HEADER, BETA_TERM, BETA_RENT])
    assert support(None, "¿Qué dice el contrato?", [])
    # «¿Qué fecha…?» exige fecha de calendario; «¿Cuándo…?» acepta un momento relativo.
    assert not support(answer_type.DATE, "¿En qué fecha se entregó la bodega?", [BETA_TERM])
    assert support(answer_type.DATE, "¿Cuándo termina el arrendamiento?", [BETA_TERM])
    # Un monto es una cifra monetaria o un porcentaje; un plazo o una cantidad de meses no lo es.
    assert support(answer_type.AMOUNT, "¿Cuál es el monto de la pena?", ["equivalente al uno por ciento del valor del pedido"])
    assert support(answer_type.AMOUNT, "¿Cuánto se estima?", ["Estimación interna: $80,000 MXN"])
    assert not support(answer_type.AMOUNT, "¿Cuánto cuesta cada correctivo?", ["dentro de las cuarenta y ocho horas siguientes al reporte"])
    assert answer_type.detect_answer_type("¿Cuánto dura la obligación de confidencialidad?") == answer_type.DURATION


@pytest.mark.contract
def test_entidades_nombradas_de_la_consulta() -> None:
    assert answer_type.entity_terms("¿Qué ley rige el contrato Beta?") == {"beta"}
    assert answer_type.entity_terms("¿Qué acción promovió la empresa contra Distribuidora Zeta?") == {"distribuidora", "zeta"}
    assert answer_type.entity_terms("Contratos vigentes") == set()


@pytest.mark.contract
def test_regresion_fn11_cantidad_sin_cifra_no_es_estado_1(monkeypatch) -> None:
    """FN11: la auditoría describe el hallazgo de proveedores, pero no dice cuántos fueron."""
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: {"alta": 0.0497, "auditoría": 0.0467, "dados": 0.0099, "fueron": 0.008,
                                                                      "proveedores": 0.1149, "validación": 0.0504})
    findings = _fragment(AUDIT_FINDINGS, document="AUDITORIA")
    state = gates.gated_evidence_state("¿Cuántos proveedores fueron dados de alta sin validación según la auditoría?", VECTOR, [findings],
                                       {findings.fragment_id: 0.5832}, lambda _t: VECTOR)
    assert state is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_regresion_fn13_ley_aplicable_sin_referencia_normativa_no_es_estado_1(monkeypatch) -> None:
    """FN13: «Contrato de arrendamiento Beta» localiza el documento, pero no dice qué ley lo rige."""
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: {"arrendamiento": 0.1299, "beta": 0.194, "contrato": 0.0581, "ley": 0.0674, "rige": 0.0456})
    header = _fragment(BETA_HEADER, document="BETA")
    term = _fragment(BETA_TERM, document="BETA", vector_rank=3, bm25_rank=2)
    state = gates.gated_evidence_state("¿Qué ley rige el contrato de arrendamiento Beta?", VECTOR, [header, term],
                                       {header.fragment_id: 0.5686, term.fragment_id: 0.4081}, lambda _t: VECTOR)
    assert state is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_entidad_no_sustituye_al_concepto_preguntado(central) -> None:
    """Si solo la entidad es central, se exige además el concepto no nominal más importante."""
    central({"beta": 0.30, "renta": 0.05, "contrato": 0.04})
    header = _fragment(BETA_HEADER, document="BETA")
    assert gates.gated_evidence_state("¿Cómo se actualiza la renta del contrato Beta?", VECTOR, [header], {header.fragment_id: 0.6},
                                      lambda _t: VECTOR) is EvidenceState.EVIDENCIA_INSUFICIENTE
    rent = _fragment(BETA_RENT, document="BETA", vector_rank=2)
    assert gates.gated_evidence_state("¿Cómo se actualiza la renta del contrato Beta?", VECTOR, [header, rent],
                                      {header.fragment_id: 0.6, rent.fragment_id: 0.55}, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE


@pytest.mark.contract
@pytest.mark.parametrize(("query", "importance", "document", "text"), [
    ("¿Cuánto es la renta mensual del arrendamiento Beta?", {"renta": 0.12, "beta": 0.15, "arrendamiento": 0.08, "mensual": 0.05}, "BETA", BETA_RENT),
    ("¿Cuánto tiempo dura el arrendamiento Beta?", {"dura": 0.1, "beta": 0.15, "arrendamiento": 0.09}, "BETA", "Contrato de arrendamiento Beta: dura tres años."),
    ("¿Cuántas cotizaciones faltaron según la auditoría?", {"cotizaciones": 0.14, "auditoría": 0.05, "faltaron": 0.03}, "AUDITORIA", AUDIT_FINDINGS),
])
def test_respondible_con_valor_presente_alcanza_estado_1(central, query, importance, document, text) -> None:
    central(importance)
    header = _fragment("Contrato de arrendamiento Beta. Informe de auditoría", document=document)
    item = _fragment(text, document=document, vector_rank=2)
    state = gates.gated_evidence_state(query, VECTOR, [header, item], {header.fragment_id: 0.6, item.fragment_id: 0.58}, lambda _t: VECTOR)
    assert state is ProcessingOutcome.GENERATION_CANDIDATE


@pytest.mark.contract
def test_regresion_fuera_de_dominio_capital_de_japon_no_es_estado_1(monkeypatch) -> None:
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: {"capital": 0.3124, "japón": 0.2658})
    calendar = _fragment("Calendario ficticio de obligaciones fiscales y regulatorias del ejercicio 2026.", document="CALENDARIO")
    alfa = _fragment("Penalización: por cada día natural de retraso se aplicará una pena convencional.", document="ALFA", vector_rank=2)
    state = gates.gated_evidence_state("¿Cuál es la capital de Japón?", VECTOR, [calendar, alfa],
                                       {calendar.fragment_id: 0.2618, alfa.fragment_id: 0.238}, lambda _t: VECTOR)
    assert state is EvidenceState.SIN_EVIDENCIA


@pytest.mark.contract
def test_regresion_decision_autonoma_restringida_y_consulta_informativa_no() -> None:
    opposite = tuple(-value for value in gates.gates_config().probe.coefficients)
    assert gates.is_decision_request("Decide por mí si debo demandar a Distribuidora Zeta", opposite)
    assert not gates.is_decision_request("¿Cuánto es la renta mensual del arrendamiento Beta?", opposite)


# --- Vinculación local concepto-valor: sin fuga de valores entre cláusulas ---

PRIVACY_PROGRAM = [
    "Programa ficticio de cumplimiento en materia de protección de datos personales para Industrias Ficticias Norte.",
    "Obligaciones regulatorias: mantener actualizado el aviso de privacidad, llevar el inventario de datos personales, atender "
    "solicitudes de derechos ARCO dentro de veinte días hábiles y documentar las medidas de seguridad.",
    "Fecha límite: el aviso de privacidad actualizado deberá publicarse a más tardar el treinta de noviembre de 2026.",
    "Evidencia de cumplimiento: se conservará el acta de aprobación del aviso, las capturas de su publicación y el registro de "
    "capacitaciones al personal.",
]
QN21_IMPORTANCE = {"aviso": 0.0488, "capturas": 0.0952, "conservan": 0.052, "privacidad": 0.1184, "tiempo": 0.0055}
QN21 = "¿Durante cuánto tiempo se conservan las capturas del aviso de privacidad?"


def _paragraph_fragments(paragraphs, document, version):
    return [_fragment(text, document=document, version=version, ordinal=index, vector_rank=index + 1) for index, text in enumerate(paragraphs)]


@pytest.mark.contract
def test_regresion_qn21_plazo_de_otra_clausula_no_respalda_estado_1(monkeypatch) -> None:
    """QN21: «veinte días hábiles» es el plazo ARCO, no el de conservación de las capturas."""
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: dict(QN21_IMPORTANCE))
    fragments = _paragraph_fragments(PRIVACY_PROGRAM, "PRIVACIDAD", uuid4())
    cosines = {item.fragment_id: 0.58 for item in fragments}
    assert gates.gated_evidence_state(QN21, VECTOR, fragments, cosines, lambda _t: VECTOR) is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_regresion_qn21_en_un_solo_fragmento_con_varios_parrafos(monkeypatch) -> None:
    """El fragmentador real puede dejar todo el documento en un fragmento: la unidad local es el párrafo."""
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: dict(QN21_IMPORTANCE))
    single = _fragment("\n\n".join(PRIVACY_PROGRAM), document="PRIVACIDAD", version=uuid4(), ordinal=0)
    state = gates.gated_evidence_state(QN21, VECTOR, [single], {single.fragment_id: 0.6}, lambda _t: VECTOR)
    assert state is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_qp05_encabezado_mas_fragmento_inmediato_sigue_siendo_respondible(central) -> None:
    """QP05: el encabezado del documento aporta «bodega»; el fragmento inmediato aporta el importe."""
    central({"mensual": 0.08, "bodega": 0.12, "beta": 0.16, "arrendar": 0.075})
    header, rent, term = _paragraph_fragments([BETA_HEADER, BETA_RENT, BETA_TERM], "BETA", uuid4())
    cosines = {header.fragment_id: 0.55, rent.fragment_id: 0.6, term.fragment_id: 0.48}
    query = "¿Qué importe mensual se paga por arrendar la bodega Beta?"
    assert gates.gated_evidence_state(query, VECTOR, [header, rent, term], cosines, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE
    # El mismo documento como un solo fragmento con párrafos: la apertura precede inmediatamente a la renta.
    single = _fragment("\n\n".join([BETA_HEADER, BETA_RENT, BETA_TERM]), document="BETA", version=uuid4(), ordinal=0)
    assert gates.gated_evidence_state(query, VECTOR, [single], {single.fragment_id: 0.6}, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE


@pytest.mark.contract
def test_encabezado_de_renglon_y_valor_en_el_renglon_siguiente(central) -> None:
    """«Renta» como encabezado y «$25,000 mensuales» debajo forman una unidad válida."""
    central({"renta": 0.15, "mensual": 0.07, "oficina": 0.1})
    text = "Contrato de arrendamiento de oficina\nRenta\n$25,000 mensuales\nDepósito\nUn mes de renta"
    item = _fragment(text, document="OFICINA", version=uuid4(), ordinal=0)
    state = gates.gated_evidence_state("¿Cuánto es la renta mensual de la oficina?", VECTOR, [item], {item.fragment_id: 0.6}, lambda _t: VECTOR)
    assert state is ProcessingOutcome.GENERATION_CANDIDATE


@pytest.mark.contract
def test_fragmento_distante_no_aporta_el_concepto_al_valor(central) -> None:
    """El encabezado aporta «bodega», pero el plazo está en una cláusula que no lo sigue inmediatamente."""
    central({"bodega": 0.12, "depósito": 0.1})
    deposit = "Depósito: se devolverá dentro de treinta días al término del contrato, descontando adeudos o daños."
    fragments = _paragraph_fragments([BETA_HEADER, BETA_RENT, BETA_TERM, deposit], "BETA", uuid4())
    cosines = {item.fragment_id: 0.55 for item in fragments}
    query = "¿En cuántos días se devuelve el depósito de la bodega?"
    assert gates.gated_evidence_state(query, VECTOR, fragments, cosines, lambda _t: VECTOR) is EvidenceState.EVIDENCIA_INSUFICIENTE
    # Con la vinculación por documento completo (regla anterior) este caso sí alcanzaba Estado 1.
    unbound = gates.gates_config().__class__(**{**gates.gates_config().__dict__, "concept_value_binding": False})
    assert gates.gated_evidence_state(query, VECTOR, fragments, cosines, lambda _t: VECTOR, unbound) is ProcessingOutcome.GENERATION_CANDIDATE


@pytest.mark.contract
def test_fragmentos_contiguos_con_traslape_y_misma_clausula_forman_una_unidad(central) -> None:
    central({"penalización": 0.15, "retraso": 0.1})
    version = uuid4()
    first = _fragment("Cláusula 7. Penalización\nPor cada día de retraso en la entrega se aplicará una pena convencional equivalente",
                      document="ALFA", version=version, ordinal=4, clause="Cláusula 7. Penalización")
    second = _fragment("retraso en la entrega se aplicará una pena convencional equivalente al dos por ciento del valor del pedido.",
                       document="ALFA", version=version, ordinal=5, clause="Cláusula 7. Penalización", vector_rank=2)
    query = "¿Cuál es el monto de la penalización por retraso?"
    cosines = {first.fragment_id: 0.6, second.fragment_id: 0.55}
    assert gates.gated_evidence_state(query, VECTOR, [first, second], cosines, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE
    # Otra cláusula sin traslape real: son unidades distintas y el porcentaje no se vincula a la penalización.
    other = _fragment("Cláusula 8. Pagos\nEl cliente pagará intereses del dos por ciento mensual.", document="ALFA", version=version,
                      ordinal=5, clause="Cláusula 8. Pagos", vector_rank=2)
    cosines = {first.fragment_id: 0.6, other.fragment_id: 0.55}
    assert gates.gated_evidence_state(query, VECTOR, [first, other], cosines, lambda _t: VECTOR) is EvidenceState.EVIDENCIA_INSUFICIENTE


@pytest.mark.contract
def test_unidades_locales_no_combinan_bloques_distantes() -> None:
    units = local_units(_paragraph_fragments(PRIVACY_PROGRAM, "PRIVACIDAD", uuid4()))
    assert not any("capturas" in unit and "veinte días" in unit for unit in units)
    # El bloque de apertura solo acompaña al contenido que lo sigue inmediatamente.
    assert any(unit.startswith("Programa ficticio") and "veinte días" in unit for unit in units)
    assert not any(unit.startswith("Programa ficticio") and "capturas" in unit for unit in units)
    table = local_units([_fragment("Fecha\n15/06/2026\nResultado\nAtendida con evidencia", ordinal=0, version=uuid4())])
    assert "Fecha 15/06/2026" in table


@pytest.mark.contract
def test_continuacion_real_aunque_la_etiqueta_de_seccion_del_fragmento_cambie(central) -> None:
    """El fragmentador etiqueta cada fragmento con la primera sección que contiene; el traslape prueba la continuidad."""
    central({"hospedaje": 0.16, "tope": 0.12, "noche": 0.09})
    version = uuid4()
    first = _fragment("Sección 2. Hospedaje\nEl hospedaje se reservará por conducto del área de compras. Las solicitudes se registrarán en el sistema de viajes",
                      document="MU", version=version, ordinal=0, section="Sección 1. Objeto")
    second = _fragment("Las solicitudes se registrarán en el sistema de viajes. En todos los casos el tope será de dos mil quinientos pesos por noche.\n\n"
                       "Sección 3. Alimentos\nCuota de seiscientos pesos diarios.", document="MU", version=version, ordinal=1,
                       section="Sección 3. Alimentos", vector_rank=2)
    cosines = {first.fragment_id: 0.55, second.fragment_id: 0.52}
    query = "¿Cuál es el monto del tope de hospedaje por noche?"
    assert gates.gated_evidence_state(query, VECTOR, [first, second], cosines, lambda _t: VECTOR) is ProcessingOutcome.GENERATION_CANDIDATE
    # La sección siguiente no hereda el concepto: la cuota de alimentos no es el tope de hospedaje.
    assert not any("hospedaje" in unit.casefold() and "seiscientos" in unit for unit in local_units([first, second]))


@pytest.mark.contract
def test_un_valor_sin_punto_no_es_rotulo_del_bloque_siguiente() -> None:
    """«15 de enero de 2026» es el valor de «Fecha de firma», no el contexto de «Testigos»."""
    text = "Fecha de firma\n15 de enero de 2026\n\nTestigos\nDos testigos del área de recursos humanos."
    units = local_units([_fragment(text, ordinal=0, version=uuid4())])
    assert "Fecha de firma 15 de enero de 2026" in units
    assert not any("2026" in unit and "testigos" in unit.casefold() for unit in units)
    table = local_units([_fragment("ID\nDOC-COMP-2026-001\nFecha\n15/06/2026\nResultado\nAtendida con evidencia", ordinal=0, version=uuid4())])
    assert "Fecha 15/06/2026" in table and not any("15/06/2026" in unit and "Resultado" in unit for unit in table)


# --- Generación sustentada: los gates locales nunca declaran Estado 1 ---

RESIDUAL = {
    "LN14": ("¿Cuánto suman los intereses moratorios reclamados a Distribuidora Zeta?",
             {"distribuidora": 0.0894, "intereses": 0.1164, "moratorios": 0.1161, "reclamados": 0.0678, "suman": 0.046, "zeta": 0.1272},
             ["Juicio ordinario mercantil Zeta 88/2026 promovido por Industrias Ficticias Norte contra Distribuidora Zeta por falta de pago de facturas.",
              "Monto: se reclama el pago de dos millones trescientos mil pesos por concepto de mercancía entregada y no pagada, más intereses moratorios."]),
    "LN21": ("¿Qué legislación rige el reglamento de viáticos Mu?",
             {"legislación": 0.0597, "reglamento": 0.0948, "rige": 0.0519, "viáticos": 0.1878},
             ["Reglamento interno de viáticos Mu de Industrias Ficticias Norte, aplicable a los viajes de trabajo del personal."]),
    "LN33": ("¿Cuántos días hábiles tiene el área de compras para confirmar una reservación?",
             {"compras": 0.077, "confirmar": 0.0336, "días": 0.1304, "hábiles": 0.0353, "reservación": 0.0537, "área": 0.0512},
             ["Plazo de entrega: el Proveedor deberá entregar cada pedido dentro de los diez días hábiles siguientes a la recepción de la orden de compra."]),
}


@pytest.mark.contract
@pytest.mark.parametrize("case", sorted(RESIDUAL))
def test_residual_supera_gates_locales_como_candidato_y_nunca_como_estado_1(monkeypatch, case) -> None:
    """El residual semántico lo decide la generación sustentada, no la coincidencia superficial."""
    query, importance, paragraphs = RESIDUAL[case]
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: dict(importance))
    fragments = _paragraph_fragments(paragraphs, case, uuid4())
    state = gates.gated_evidence_state(query, VECTOR, fragments, {item.fragment_id: 0.58 for item in fragments}, lambda _t: VECTOR)
    assert state is ProcessingOutcome.GENERATION_CANDIDATE and state is not EvidenceState.EVIDENCIA_SUFICIENTE
