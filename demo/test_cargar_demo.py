"""Pruebas del desplazamiento de fechas del cargador de demostración: python -m unittest demo/test_cargar_demo.py"""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cargar_demo as demo  # noqa: E402


class DesplazamientoDeFechas(unittest.TestCase):
    def test_el_ultimo_mes_de_datos_es_el_mes_en_curso(self):
        self.assertEqual(demo.desplazamiento_meses(date(2026, 10, 21)), 0)
        self.assertEqual(demo.desplazamiento_meses(date(2027, 3, 15)), 5)

    def test_el_dia_primero_los_datos_terminan_en_el_mes_anterior(self):
        self.assertEqual(demo.desplazamiento_meses(date(2026, 11, 1)), 0)

    def test_ajusta_el_dia_al_largo_del_mes_destino(self):
        self.assertEqual(demo.desplazar("2026-05-31", 1, tope=None), "2026-06-30")

    def test_las_fechas_de_evento_nunca_quedan_en_el_futuro(self):
        self.assertEqual(demo.desplazar("2026-10-28", 0, tope=date(2026, 10, 20)), "2026-10-20")

    def test_una_fecha_invalida_a_proposito_se_conserva(self):
        self.assertEqual(demo.desplazar("2026-09-31", 3, tope=None), "2026-09-31")

    def test_el_csv_desplaza_eventos_y_plazos_y_conserva_lo_demas(self):
        contenido = "ID_Obligacion,Fecha_Limite,Evidencia_Cumplimiento\nOBL-1,2026-10-05,\nOBL-2,,\n".encode("utf-8")
        resultado = demo.csv_desplazado(contenido, 2, date(2026, 12, 20)).decode("utf-8").splitlines()
        self.assertEqual(resultado, ["ID_Obligacion,Fecha_Limite,Evidencia_Cumplimiento", "OBL-1,2026-12-05,", "OBL-2,,"])

    def test_todas_las_cargas_existen(self):
        for _, archivo, _ in demo.CARGAS:
            self.assertTrue((demo.DEMO / archivo).is_file(), archivo)


if __name__ == "__main__":
    unittest.main()
