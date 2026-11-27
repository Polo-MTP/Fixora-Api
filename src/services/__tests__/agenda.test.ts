import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  agendaRange,
  appointmentEnd,
  assertBlockFits,
  groupAgendaByDay,
  parseAgendaDays,
  parseAgendaFrom,
  parseBlockInput,
  validateBlockWindow,
  type AgendaAppointment,
  type AgendaBlock,
} from '../agenda.rules.ts';
import { AppError, BadRequestError } from '../../errors/app-error.ts';
import { addDays, localDateTimeToUtc } from '../../utils/timezone.ts';

// Torreón no cambia de horario: siempre UTC-6.
const TZ = 'America/Monterrey';
const at = (iso: string) => new Date(iso);

function appointment(
  id: string,
  start: string,
  end: string,
  status = 'aceptada',
): AgendaAppointment {
  return {
    id,
    status,
    employeeId: '2',
    start: at(start),
    end: at(end),
    categoryName: 'Plomería',
    clientName: 'Ana Pérez',
    zone: 'Centro',
  };
}

function block(id: string, start: string, end: string): AgendaBlock {
  return { id, employeeId: '2', start: at(start), end: at(end), reason: 'personal' };
}

describe('API-45: agenda del proveedor', () => {
  it('el día local de Torreón va de las 06:00 UTC a las 06:00 UTC del día siguiente', () => {
    const range = agendaRange('2026-12-01', 1, TZ);
    assert.equal(range.start.toISOString(), '2026-12-01T06:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-12-02T06:00:00.000Z');
    assert.equal(agendaRange('2026-12-01', 7, TZ).end.toISOString(), '2026-12-08T06:00:00.000Z');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(
      localDateTimeToUtc('2026-12-01', '09:30', TZ).toISOString(),
      '2026-12-01T15:30:00.000Z',
    );
  });

  it('una cita cuenta el día local en que empieza, aunque en UTC ya sea el siguiente', () => {
    // 22:30 del 1 de diciembre en Torreón = 04:30 UTC del 2.
    const late = appointment('170', '2026-12-02T04:30:00Z', '2026-12-02T05:30:00Z');
    const days = groupAgendaByDay('2026-12-01', 2, TZ, [], [late], []);

    assert.equal(days[0]!.appointments.length, 1);
    assert.equal(days[0]!.appointments[0]!.request_id, '170');
    assert.equal(days[1]!.appointments.length, 0);
  });

  it('cada día trae el horario de la sucursal de ese día de la semana', () => {
    const hours = [
      { dayOfWeek: 2, openTime: '09:00:00', closeTime: '14:00:00' },
      { dayOfWeek: 2, openTime: '16:00:00', closeTime: '19:00:00' },
      { dayOfWeek: 0, openTime: '10:00:00', closeTime: '13:00:00' },
    ];
    // 1 de diciembre de 2026 es martes.
    const [tuesday, wednesday] = groupAgendaByDay('2026-12-01', 2, TZ, hours, [], []);

    assert.equal(tuesday!.day_of_week, 2);
    assert.deepEqual(tuesday!.hours, [
      { open_time: '09:00', close_time: '14:00' },
      { open_time: '16:00', close_time: '19:00' },
    ]);
    assert.deepEqual(wednesday!.hours, []);
  });

  it('las citas salen en orden y una pendiente avisa que hay que responderla', () => {
    const days = groupAgendaByDay(
      '2026-12-01',
      1,
      TZ,
      [],
      [
        appointment('2', '2026-12-01T20:00:00Z', '2026-12-01T21:00:00Z'),
        appointment('1', '2026-12-01T16:00:00Z', '2026-12-01T17:00:00Z', 'pendiente'),
        appointment('3', '2026-12-01T22:00:00Z', '2026-12-01T23:00:00Z', 'en_curso'),
      ],
      [],
    );
    const items = days[0]!.appointments;

    assert.deepEqual(
      items.map((a) => a.request_id),
      ['1', '2', '3'],
    );
    assert.equal(items[0]!.needs_response, true);
    assert.equal(items[1]!.needs_response, false);
    assert.equal(items[2]!.status, 'en_camino');
  });

  it('unas vacaciones aparecen en cada día que tocan', () => {
    const vacation = block('9', '2026-12-01T06:00:00Z', '2026-12-04T06:00:00Z');
    const days = groupAgendaByDay('2026-11-30', 5, TZ, [], [], [vacation]);

    assert.deepEqual(
      days.map((day) => day.blocks.length),
      [0, 1, 1, 1, 0],
    );
  });

  it('las citas guardadas sin fin duran lo que su categoría, o una hora', () => {
    const start = at('2026-12-01T16:00:00Z');
    assert.equal(appointmentEnd(start, null, 90).toISOString(), '2026-12-01T17:30:00.000Z');
    assert.equal(appointmentEnd(start, null, null).toISOString(), '2026-12-01T17:00:00.000Z');
    const end = at('2026-12-01T16:45:00Z');
    assert.equal(appointmentEnd(start, end, 90), end);
  });

  it('sin fecha, la agenda empieza hoy en Torreón', () => {
    // 03:00 UTC del 2 de diciembre todavía es 1 de diciembre en Torreón.
    assert.equal(parseAgendaFrom(undefined, TZ, at('2026-12-02T03:00:00Z')), '2026-12-01');
    assert.equal(parseAgendaFrom('2026-12-05', TZ), '2026-12-05');
    for (const bad of ['2026-13-01', '2026-02-30', '01/12/2026', 5]) {
      assert.throws(() => parseAgendaFrom(bad, TZ), BadRequestError, String(bad));
    }
  });

  it('days va de 1 a 31', () => {
    assert.equal(parseAgendaDays(undefined), 1);
    assert.equal(parseAgendaDays('7'), 7);
    for (const bad of ['0', '32', '2.5', 'semana']) {
      assert.throws(() => parseAgendaDays(bad), BadRequestError, bad);
    }
  });

  it('crear un bloqueo pide inicio, fin y un motivo válido', () => {
    const input = parseBlockInput(
      {
        employee_id: '2',
        starts_at: '2026-12-01T16:00:00Z',
        ends_at: '2026-12-01T18:00:00Z',
        reason: 'personal',
      },
      false,
    );
    assert.equal(input.employeeId, 2n);
    assert.equal(input.reason, 'personal');

    assert.throws(
      () => parseBlockInput({ starts_at: '2026-12-01T16:00:00Z', reason: 'personal' }, false),
      BadRequestError,
    );
    assert.throws(
      () =>
        parseBlockInput(
          { starts_at: 'mañana', ends_at: '2026-12-01T18:00:00Z', reason: 'personal' },
          false,
        ),
      BadRequestError,
    );
    assert.throws(
      () =>
        parseBlockInput(
          { starts_at: '2026-12-01T16:00:00Z', ends_at: '2026-12-01T18:00:00Z', reason: 'fiesta' },
          false,
        ),
      BadRequestError,
    );
  });

  it('editar un bloqueo acepta solo lo que cambia, pero no cambiar de técnico', () => {
    assert.deepEqual(parseBlockInput({ reason: 'vacaciones' }, true), { reason: 'vacaciones' });
    assert.throws(() => parseBlockInput({}, true), BadRequestError);
    assert.throws(() => parseBlockInput({ employee_id: '3' }, true), BadRequestError);
  });

  it('un bloqueo termina después de empezar, no ya pasado y dura hasta 60 días', () => {
    const now = at('2026-12-01T12:00:00Z');
    validateBlockWindow(
      { start: at('2026-12-01T10:00:00Z'), end: at('2026-12-01T14:00:00Z') },
      now,
    );

    assert.throws(
      () =>
        validateBlockWindow(
          { start: at('2026-12-01T16:00:00Z'), end: at('2026-12-01T16:00:00Z') },
          now,
        ),
      BadRequestError,
    );
    assert.throws(
      () =>
        validateBlockWindow(
          { start: at('2026-11-30T10:00:00Z'), end: at('2026-11-30T12:00:00Z') },
          now,
        ),
      BadRequestError,
    );
    assert.throws(
      () =>
        validateBlockWindow(
          { start: at('2026-12-02T00:00:00Z'), end: at('2027-02-15T00:00:00Z') },
          now,
        ),
      BadRequestError,
    );
  });

  it('un bloqueo no se encima con otro bloqueo', () => {
    const range = { start: at('2026-12-01T16:00:00Z'), end: at('2026-12-01T18:00:00Z') };
    assert.throws(
      () =>
        assertBlockFits(
          range,
          [{ start: at('2026-12-01T17:00:00Z'), end: at('2026-12-01T19:00:00Z') }],
          [],
        ),
      (error: unknown) => (error as AppError).code === 'BLOCK_OVERLAP',
    );
    // Uno que termina justo cuando empieza el otro no se encima.
    assertBlockFits(
      range,
      [{ start: at('2026-12-01T14:00:00Z'), end: at('2026-12-01T16:00:00Z') }],
      [],
    );
  });

  it('con citas en ese horario responde 409 con la lista para atenderlas', () => {
    const range = { start: at('2026-12-01T16:00:00Z'), end: at('2026-12-01T20:00:00Z') };
    const busy = [
      {
        id: '170',
        status: 'pendiente',
        start: at('2026-12-01T17:00:00Z'),
        end: at('2026-12-01T18:00:00Z'),
      },
      {
        id: '171',
        status: 'aceptada',
        start: at('2026-12-01T21:00:00Z'),
        end: at('2026-12-01T22:00:00Z'),
      },
    ];
    try {
      assertBlockFits(range, [], busy);
      assert.fail('debía chocar');
    } catch (error) {
      const appError = error as AppError & { details?: Array<{ request_id: string }> };
      assert.equal(appError.statusCode, 409);
      assert.equal(appError.code, 'SCHEDULE_CONFLICT');
      assert.deepEqual(
        appError.details!.map((d) => d.request_id),
        ['170'],
      );
    }
  });
});
