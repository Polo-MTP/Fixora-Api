import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptanceRate,
  acceptedResponseSeconds,
  averageSeconds,
  countResponses,
  parseStatsPeriod,
  responseSeconds,
  roundRating,
  type DispatchResponse,
} from '../provider-stats.rules.ts';
import { BadRequestError } from '../../errors/app-error.ts';

const TZ = 'America/Monterrey';
const at = (iso: string) => new Date(iso);

function response(
  kind: string,
  isEmergency: boolean,
  created: string,
  notified: string,
  responded: string | null,
): DispatchResponse {
  return {
    response: kind,
    isEmergency,
    requestCreatedAt: at(created),
    notifiedAt: at(notified),
    respondedAt: responded ? at(responded) : null,
  };
}

describe('API-44: estadísticas del proveedor', () => {
  it('sin fechas son los últimos 30 días hasta hoy en Torreón', () => {
    // 03:00 UTC del 28 todavía es 27 de noviembre en Torreón.
    assert.deepEqual(parseStatsPeriod({}, TZ, at('2026-11-28T03:00:00Z')), {
      from: '2026-10-29',
      to: '2026-11-27',
    });
  });

  it('con un solo día, from y to son el mismo; con una sola fecha se completan 30 días', () => {
    assert.deepEqual(parseStatsPeriod({ from: '2026-11-27', to: '2026-11-27' }, TZ), {
      from: '2026-11-27',
      to: '2026-11-27',
    });
    assert.deepEqual(parseStatsPeriod({ from: '2026-11-01' }, TZ), {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    assert.deepEqual(parseStatsPeriod({ to: '2026-11-30' }, TZ), {
      from: '2026-11-01',
      to: '2026-11-30',
    });
  });

  it('rechaza fechas inválidas, al revés o de más de un año', () => {
    for (const query of [
      { from: '2026-02-30' },
      { from: '27/11/2026' },
      { from: '2026-11-28', to: '2026-11-27' },
      { from: '2025-01-01', to: '2026-11-27' },
    ]) {
      assert.throws(() => parseStatsPeriod(query, TZ), BadRequestError, JSON.stringify(query));
    }
  });

  it('en una solicitud normal el tiempo de respuesta se mide desde que el cliente la creó', () => {
    // El registro de la respuesta se crea al responder: notified_at = responded_at.
    const normal = response(
      'acepto',
      false,
      '2026-11-27T16:00:00Z',
      '2026-11-27T16:03:00Z',
      '2026-11-27T16:03:00Z',
    );
    assert.equal(responseSeconds(normal), 180);
  });

  it('en una emergencia se mide desde que le llegó el aviso', () => {
    const emergency = response(
      'rechazo',
      true,
      '2026-11-27T16:00:00Z',
      '2026-11-27T16:01:00Z',
      '2026-11-27T16:01:45Z',
    );
    assert.equal(responseSeconds(emergency), 45);
  });

  it('una vencida no tiene tiempo de respuesta', () => {
    assert.equal(
      responseSeconds(
        response(
          'expiro',
          true,
          '2026-11-27T16:00:00Z',
          '2026-11-27T16:00:00Z',
          '2026-11-27T16:05:00Z',
        ),
      ),
      null,
    );
    assert.equal(averageSeconds([180, null, 45]), 113);
    assert.equal(averageSeconds([null]), null);
  });

  it('el porcentaje de aceptación cuenta las vencidas como no aceptadas', () => {
    assert.equal(acceptanceRate(6, 1, 1), 75);
    assert.equal(acceptanceRate(2, 1, 0), 66.7);
    assert.equal(acceptanceRate(0, 0, 0), null);
  });

  it('de los registros de respuesta cuenta rechazos y vencidas', () => {
    const rows = [
      response(
        'acepto',
        false,
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:01:00Z',
      ),
      response(
        'acepto',
        true,
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:01:00Z',
      ),
      response(
        'rechazo',
        false,
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:01:00Z',
      ),
      response(
        'expiro',
        true,
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:00:00Z',
        '2026-11-27T16:05:00Z',
      ),
    ];
    assert.deepEqual(countResponses(rows), { rejected: 1, expired: 1 });
  });

  it('una aceptada se mide desde el aviso si era emergencia, o desde que se creó', () => {
    const created = at('2026-11-27T16:00:00Z');
    const acceptedAt = at('2026-11-27T16:02:00Z');
    assert.equal(
      acceptedResponseSeconds({
        isEmergency: false,
        createdAt: created,
        acceptedAt,
        notifiedAt: null,
      }),
      120,
    );
    assert.equal(
      acceptedResponseSeconds({
        isEmergency: true,
        createdAt: created,
        acceptedAt,
        notifiedAt: at('2026-11-27T16:01:30Z'),
      }),
      30,
    );
    // Sin registro del aviso, se mide desde que se creó.
    assert.equal(
      acceptedResponseSeconds({
        isEmergency: true,
        createdAt: created,
        acceptedAt,
        notifiedAt: null,
      }),
      120,
    );
  });

  it('la calificación lleva un decimal y es null sin reseñas', () => {
    assert.equal(roundRating('4.666666', 3), 4.7);
    assert.equal(roundRating(null, 0), null);
    assert.equal(roundRating('5', 0), null);
  });
});
