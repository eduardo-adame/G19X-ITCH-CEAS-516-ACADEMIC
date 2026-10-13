"""ROBUSTNESS: recrear aplicaciones conserva la selección explícita de base."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


COMPOSE = Path(__file__).resolve().parents[2] / 'docker-compose.yml'


def projected_config(tmp_path, values):
    if shutil.which('docker') is None:
        pytest.skip('Docker CLI requerida para comprobar interpolación, sin daemon ni servicios')
    fixture = tmp_path / 'synthetic.env'
    fixture.write_text('\n'.join([
        'POSTGRES_PASSWORD=synthetic-not-a-real-credential',
        'RUNTIME_POSTGRES_USER=synthetic-runtime',
        'RUNTIME_POSTGRES_PASSWORD=synthetic-not-a-real-credential',
        'AIRFLOW_INGESTION_PASSWORD=synthetic-not-a-real-credential',
        'AIRFLOW_ADMIN_PASSWORD=synthetic-not-a-real-credential',
        *[key + '=' + value for key, value in values.items()],
    ]), encoding='utf-8')
    environment = {key: value for key, value in os.environ.items()
                   if key not in {'POSTGRES_DB', 'RUNTIME_POSTGRES_DB'}}
    completed = subprocess.run(
        ['docker', 'compose', '-f', str(COMPOSE), '--env-file', str(fixture), 'config', '--format', 'json'],
        capture_output=True, text=True, encoding='utf-8', env=environment, check=False,
    )
    # No incluir configuración completa ni variables privadas en los fallos.
    assert completed.returncode == 0, 'La configuración sintética no pudo resolverse'
    services = json.loads(completed.stdout)['services']
    return {name: service.get('environment', {}).get('POSTGRES_DB')
            for name, service in services.items()}


@pytest.mark.parametrize('override', [None, ''])
def test_unset_or_empty_runtime_database_preserves_primary_fallback(tmp_path, override):
    values = {'POSTGRES_DB': 'synthetic_primary_test'}
    if override is not None:
        values['RUNTIME_POSTGRES_DB'] = override
    projected = projected_config(tmp_path, values)
    assert projected['postgres'] == projected['backend'] == 'synthetic_primary_test'


def test_explicit_runtime_database_changes_backend_only(tmp_path):
    projected = projected_config(tmp_path, {
        'POSTGRES_DB': 'synthetic_primary_test', 'RUNTIME_POSTGRES_DB': 'synthetic_existing_test'})
    assert projected['postgres'] == 'synthetic_primary_test'
    assert projected['backend'] == 'synthetic_existing_test'
    assert all(value is None for name, value in projected.items() if name not in {'postgres', 'backend'})


def test_both_database_variables_absent_preserve_default(tmp_path):
    projected = projected_config(tmp_path, {})
    assert projected['postgres'] == projected['backend'] == 'riesgo_legal'
