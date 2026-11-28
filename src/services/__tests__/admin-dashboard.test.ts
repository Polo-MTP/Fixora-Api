import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SERVICE_STATUSES, countByStatus } from '../admin-dashboard.rules.ts';

describe('API-52: tablero del panel de administración', () => {
  it('trae todos los estados aunque no haya servicios en alguno', () => {
    const result = countByStatus([
      { status: 'completada', total: 12 },
      { status: 'pendiente', total: 3 },
    ]);

    assert.deepEqual(Object.keys(result.by_status), [...SERVICE_STATUSES]);
    assert.equal(result.by_status.completada, 12);
    assert.equal(result.by_status.cancelada, 0);
    assert.equal(result.total, 15);
  });

  it('en_curso es el nombre anterior de en_camino y se suma ahí', () => {
    const result = countByStatus([
      { status: 'en_camino', total: 2 },
      { status: 'en_curso', total: 1 },
    ]);

    assert.equal(result.by_status.en_camino, 3);
    assert.equal(result.total, 3);
  });

  it('sin servicios todo va en cero', () => {
    const result = countByStatus([]);
    assert.equal(result.total, 0);
    assert.ok(Object.values(result.by_status).every((value) => value === 0));
  });
});
