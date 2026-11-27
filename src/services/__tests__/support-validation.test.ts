import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  INBOX_OVERDUE_HOURS,
  buildResolveBody,
  computeServiceDurations,
  distanceMeters,
  isOverdue,
  mergeTimeline,
  parseInboxQuery,
  parseTimelineQuery,
  reportAgeHours,
  toGeoPoint,
  type TimelineEntry,
} from '../../utils/support-validation.ts';

const entry = (at: string, type: TimelineEntry['type'], title: string): TimelineEntry => ({
  at,
  type,
  kind: 'x',
  title,
  actor: null,
  details: {},
  location: null,
});

describe('endpoints de soporte e historial del servicio (API-41)', () => {
  describe('parseInboxQuery', () => {
    it('usa página 1, 20 por página y orden por prioridad', () => {
      const query = parseInboxQuery({});
      assert.equal(query.page, 1);
      assert.equal(query.limit, 20);
      assert.equal(query.sort, 'prioridad');
      assert.equal(query.status, null);
      assert.equal(query.assigned, null);
    });

    it('acepta varios estados separados por coma, sin repetir', () => {
      const query = parseInboxQuery({ status: 'pendiente, en_revision,pendiente' });
      assert.deepEqual(query.status, ['pendiente', 'en_revision']);
    });

    it('acepta todos los filtros válidos', () => {
      const query = parseInboxQuery({
        page: '2',
        limit: '50',
        type: 'garantia',
        category: 'danos',
        priority: 'urgente',
        request_id: '501',
        assigned: 'unassigned',
        q: 'gar-2026',
        sort: 'actividad',
      });
      assert.equal(query.type, 'garantia');
      assert.equal(query.request_id, 501n);
      assert.equal(query.assigned, 'unassigned');
      assert.equal(query.q, 'GAR-2026');
      assert.equal(query.sort, 'actividad');
      assert.equal(parseInboxQuery({ assigned: 'me' }).assigned, 'me');
      assert.equal(parseInboxQuery({ assigned: '9' }).assigned, 9n);
    });

    it('rechaza filtros inválidos', () => {
      assert.throws(() => parseInboxQuery({ status: 'abierto' }), BadRequestError);
      assert.throws(() => parseInboxQuery({ status: 'pendiente,x' }), BadRequestError);
      assert.throws(() => parseInboxQuery({ assigned: 'todos' }), BadRequestError);
      assert.throws(() => parseInboxQuery({ sort: 'nombre' }), BadRequestError);
      assert.throws(() => parseInboxQuery({ limit: '101' }), BadRequestError);
      assert.throws(() => parseInboxQuery({ page: '0' }), BadRequestError);
      assert.throws(() => parseInboxQuery({ q: 'REP 1; drop' }), BadRequestError);
    });

    it('created_to sin hora incluye todo ese día', () => {
      const query = parseInboxQuery({ created_from: '2026-11-01', created_to: '2026-11-30' });
      assert.equal(query.created_from?.toISOString(), '2026-11-01T00:00:00.000Z');
      assert.equal(query.created_before?.toISOString(), '2026-12-01T00:00:00.000Z');
    });

    it('created_to con hora se respeta tal cual, y el rango debe tener sentido', () => {
      assert.equal(
        parseInboxQuery({ created_to: '2026-11-30T12:00:00Z' }).created_before?.toISOString(),
        '2026-11-30T12:00:00.000Z',
      );
      assert.throws(
        () => parseInboxQuery({ created_from: '2026-12-01', created_to: '2026-11-01' }),
        BadRequestError,
      );
      assert.throws(() => parseInboxQuery({ created_from: 'ayer' }), BadRequestError);
    });
  });

  describe('buildResolveBody', () => {
    it('convierte el cuerpo en una resolución', () => {
      assert.deepEqual(
        buildResolveBody({ resolution_type: 'reembolso', comment: 'Se reembolsó el cobro.' }),
        { resolution_type: 'reembolso', comment: 'Se reembolsó el cobro.', status: 'resuelto' },
      );
    });

    it('no deja cambiar el estado ni mandar otros campos', () => {
      assert.throws(
        () => buildResolveBody({ resolution_type: 'otro', comment: 'x', status: 'rechazado' }),
        BadRequestError,
      );
      assert.throws(() => buildResolveBody({ assigned_to: '1' }), BadRequestError);
      assert.throws(() => buildResolveBody(null), BadRequestError);
      assert.throws(() => buildResolveBody([]), BadRequestError);
    });
  });

  describe('parseTimelineQuery', () => {
    it('sin types devuelve todo', () => {
      assert.deepEqual(parseTimelineQuery({}), { types: null });
    });

    it('acepta una lista de tipos', () => {
      const { types } = parseTimelineQuery({ types: 'estado, pago,chat' });
      assert.deepEqual([...(types ?? [])].sort(), ['chat', 'estado', 'pago']);
    });

    it('rechaza tipos inválidos o vacíos', () => {
      assert.throws(() => parseTimelineQuery({ types: 'estado,musica' }), BadRequestError);
      assert.throws(() => parseTimelineQuery({ types: ' , ' }), BadRequestError);
    });
  });

  describe('antigüedad de la bandeja', () => {
    const created = new Date('2026-11-20T00:00:00Z');

    it('calcula las horas desde que se creó', () => {
      assert.equal(reportAgeHours(created, new Date('2026-11-20T05:59:00Z')), 5);
      assert.equal(reportAgeHours(created, new Date('2026-11-19T00:00:00Z')), 0);
    });

    it('un caso abierto se atrasa pasadas las horas límite; uno cerrado nunca', () => {
      assert.equal(INBOX_OVERDUE_HOURS, 48);
      const early = new Date('2026-11-21T23:00:00Z');
      const late = new Date('2026-11-22T00:00:00Z');
      assert.equal(isOverdue('pendiente', created, early), false);
      assert.equal(isOverdue('pendiente', created, late), true);
      assert.equal(isOverdue('en_revision', created, late), true);
      assert.equal(isOverdue('resuelto', created, late), false);
      assert.equal(isOverdue('rechazado', created, late), false);
    });
  });

  describe('mergeTimeline', () => {
    it('ordena de la más antigua a la más reciente', () => {
      const merged = mergeTimeline([
        entry('2026-11-20T10:05:00Z', 'pago', 'pago'),
        entry('2026-11-20T10:00:00Z', 'estado', 'estado'),
        entry('2026-11-20T10:02:00Z', 'chat', 'chat'),
      ]);
      assert.deepEqual(
        merged.map((item) => item.title),
        ['estado', 'chat', 'pago'],
      );
    });

    it('con la misma hora, primero el estado y después lo que se origina en él', () => {
      const merged = mergeTimeline([
        entry('2026-11-20T10:00:00Z', 'chat', 'chat'),
        entry('2026-11-20T10:00:00Z', 'pago', 'pago'),
        entry('2026-11-20T10:00:00Z', 'estado', 'estado'),
        entry('2026-11-20T10:00:00Z', 'cancelacion', 'cancelacion'),
      ]);
      assert.deepEqual(
        merged.map((item) => item.title),
        ['estado', 'cancelacion', 'pago', 'chat'],
      );
    });

    it('es estable con entradas iguales y no modifica el arreglo original', () => {
      const original = [
        entry('2026-11-20T10:00:00Z', 'chat', 'primero'),
        entry('2026-11-20T10:00:00Z', 'chat', 'segundo'),
      ];
      const merged = mergeTimeline(original);
      assert.deepEqual(
        merged.map((item) => item.title),
        ['primero', 'segundo'],
      );
      assert.equal(original[0]!.title, 'primero');
    });
  });

  describe('tiempos del servicio', () => {
    const at = (time: string) => new Date(`2026-11-20T${time}:00Z`);

    it('calcula cada tramo en minutos', () => {
      assert.deepEqual(
        computeServiceDurations({
          created_at: at('10:00'),
          accepted_at: at('10:04'),
          arrived_at: at('10:30'),
          completed_at: at('11:45'),
          canceled_at: null,
        }),
        { to_accept_minutes: 4, to_arrive_minutes: 26, service_minutes: 75, total_minutes: 105 },
      );
    });

    it('con datos faltantes devuelve null en ese tramo', () => {
      const durations = computeServiceDurations({
        created_at: at('10:00'),
        accepted_at: null,
        arrived_at: null,
        completed_at: null,
        canceled_at: null,
      });
      assert.deepEqual(durations, {
        to_accept_minutes: null,
        to_arrive_minutes: null,
        service_minutes: null,
        total_minutes: null,
      });
    });

    it('una cancelación cuenta como cierre del total', () => {
      const durations = computeServiceDurations({
        created_at: at('10:00'),
        accepted_at: at('10:05'),
        arrived_at: null,
        completed_at: null,
        canceled_at: at('10:20'),
      });
      assert.equal(durations.total_minutes, 20);
      assert.equal(durations.service_minutes, null);
    });

    it('un tramo con fechas al revés no se reporta', () => {
      const durations = computeServiceDurations({
        created_at: at('10:00'),
        accepted_at: at('09:00'),
        arrived_at: null,
        completed_at: null,
        canceled_at: null,
      });
      assert.equal(durations.to_accept_minutes, null);
    });
  });

  describe('ubicación', () => {
    it('toGeoPoint convierte las coordenadas de la base de datos', () => {
      assert.deepEqual(toGeoPoint('25.5428000', '-103.4068000'), {
        latitude: 25.5428,
        longitude: -103.4068,
      });
      assert.equal(toGeoPoint(null, '-103.4'), null);
      assert.equal(toGeoPoint('25.5', undefined), null);
      assert.equal(toGeoPoint('abc', '1'), null);
    });

    it('distanceMeters mide la distancia entre dos puntos', () => {
      const a = { latitude: 25.5428, longitude: -103.4068 };
      const b = { latitude: 25.5438, longitude: -103.4068 };
      const meters = distanceMeters(a, b);
      assert.ok(meters !== null && meters >= 105 && meters <= 115, String(meters));
      assert.equal(distanceMeters(a, a), 0);
      assert.equal(distanceMeters(null, b), null);
      assert.equal(distanceMeters(a, null), null);
    });
  });
});
