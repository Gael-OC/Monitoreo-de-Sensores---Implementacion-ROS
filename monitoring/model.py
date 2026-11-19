"""Versioned boundary shared by analog and future digital adapters."""
import math
import re
from datetime import datetime, timezone

CONTEXTS = {'dry_test', 'culture', 'unknown'}

def utcnow():
    return datetime.now(timezone.utc)

def iso(value):
    if value.tzinfo is None:
        raise ValueError('La fecha debe incluir zona horaria')
    return value.astimezone(timezone.utc).isoformat(timespec='milliseconds')

def reading(gateway_id, device_id, measurements, *, received_at=None,
            measured_at=None, context='dry_test', source='digital'):
    if context not in CONTEXTS:
        raise ValueError('Contexto desconocido')
    for identity in (gateway_id, device_id):
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', identity):
            raise ValueError('Identidad inválida')
    if not measurements:
        raise ValueError('Sin mediciones')
    cleaned = {}
    for name, item in measurements.items():
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', name):
            raise ValueError('Nombre de medición inválido')
        value = item['value']
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
            raise ValueError('Medición no finita o no numérica')
        quality = item.get('quality', 'unverified')
        if quality not in {'unverified', 'valid', 'invalid'}:
            raise ValueError('Calidad inválida')
        cleaned[name] = {'value': value, 'unit': str(item.get('unit', ''))[:30], 'quality': quality}
    return {'schema_version': 1, 'gateway_id': gateway_id, 'device_id': device_id,
            'received_at': iso(received_at or utcnow()),
            'measured_at': iso(measured_at) if measured_at else None,
            'context': context, 'source': source, 'measurements': cleaned}

def analog_adapter(values, gateway_id, **kwargs):
    if len(values) != 5:
        raise ValueError('Se esperan exactamente cinco campos ROS')
    if any(isinstance(v, bool) or not math.isfinite(v) for v in values):
        raise ValueError('Array ROS inválido')
    for v in values[3:]:
        if v != int(v) or not 0 <= v <= 0xFFFFFF:
            raise ValueError('MAC inválida')
    device_id = f'{int(values[3]):06X}{int(values[4]):06X}'
    result = reading(gateway_id, device_id, {
        'temperatura': {'value': values[0], 'unit': '°C'},
        'ph': {'value': values[1], 'unit': 'pH'}}, source='analog_ros_v1', **kwargs)
    result['diagnostics'] = {'ph_voltage_mv': values[2]}
    return result
