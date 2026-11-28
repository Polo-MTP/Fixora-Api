import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  canChat,
  canTrack,
  dbStatusesFor,
  isActiveStatus,
  parseHistoryQuery,
  paymentStatus,
  pickActiveService,
  publicStatus,
  servicePhase,
  visibleCost,
} from '../../utils/client-history.ts';

const service = (status: string, created: string) => ({
  status,
  created_at: new Date(created),
  label: `${status}-${created}`,
});

describe('historial de servicios del cliente (API-48)', () => {
  describe('parseHistoryQuery', () => {
    it('usa página 1 y 20 por página, sin filtro de estado', () => {
      assert.deepEqual(parseHistoryQuery({}), { page: 1, limit: 20, status: null });
    });

    it('acepta uno o varios estados, sin repetir', () => {
      assert.deepEqual(parseHistoryQuery({ status: 'completada' }).status, ['completada']);
      assert.deepEqual(parseHistoryQuery({ status: 'cancelada, expirada,cancelada' }).status, [
        'cancelada',
        'expirada',
      ]);
      assert.equal(parseHistoryQuery({ status: '' }).status, null);
    });

    it('rechaza estados y paginación inválidos', () => {
      assert.throws(() => parseHistoryQuery({ status: 'terminada' }), BadRequestError);
      assert.throws(() => parseHistoryQuery({ status: 'completada,x' }), BadRequestError);
      assert.throws(() => parseHistoryQuery({ page: '0' }), BadRequestError);
      assert.throws(() => parseHistoryQuery({ limit: '101' }), BadRequestError);
      assert.throws(() => parseHistoryQuery({ limit: 'diez' }), BadRequestError);
    });

    it('acepta página y límite válidos', () => {
      const query = parseHistoryQuery({ page: '3', limit: '50' });
      assert.equal(query.page, 3);
      assert.equal(query.limit, 50);
    });
  });

  describe('estados', () => {
    it('en_camino incluye los registros antiguos en_curso', () => {
      assert.deepEqual(dbStatusesFor(['en_camino', 'completada']), [
        'en_camino',
        'en_curso',
        'completada',
      ]);
      assert.deepEqual(dbStatusesFor(['llegado']), ['llegado']);
    });

    it('en_curso se muestra como en_camino', () => {
      assert.equal(publicStatus('en_curso'), 'en_camino');
      assert.equal(publicStatus('completada'), 'completada');
    });

    it('cada estado tiene su etapa para el banner', () => {
      assert.equal(servicePhase('pendiente'), 'buscando_tecnico');
      assert.equal(servicePhase('aceptada'), 'tecnico_asignado');
      assert.equal(servicePhase('en_camino'), 'tecnico_en_camino');
      assert.equal(servicePhase('en_curso'), 'tecnico_en_camino');
      assert.equal(servicePhase('llegado'), 'tecnico_en_el_lugar');
      assert.equal(servicePhase('completada'), 'finalizado');
      assert.equal(servicePhase('cancelada'), 'cancelado');
      assert.equal(servicePhase('expirada'), 'expirado');
      assert.equal(servicePhase('agendada'), 'agendado');
    });
  });

  describe('servicio en curso', () => {
    it('cuenta como en curso lo pendiente, asignado, en camino y en el lugar', () => {
      for (const status of ['pendiente', 'aceptada', 'en_camino', 'en_curso', 'llegado']) {
        assert.equal(isActiveStatus(status), true, status);
      }
      for (const status of ['agendada', 'completada', 'cancelada', 'expirada']) {
        assert.equal(isActiveStatus(status), false, status);
      }
    });

    it('elige el más avanzado: llegado, en camino, aceptada y pendiente', () => {
      const rows = [
        service('pendiente', '2026-11-20T10:00:00Z'),
        service('aceptada', '2026-11-20T09:00:00Z'),
        service('llegado', '2026-11-20T08:00:00Z'),
        service('en_camino', '2026-11-20T11:00:00Z'),
      ];
      assert.equal(pickActiveService(rows)?.status, 'llegado');
      assert.equal(
        pickActiveService(rows.filter((r) => r.status !== 'llegado'))?.status,
        'en_camino',
      );
      assert.equal(pickActiveService(rows.slice(0, 2))?.status, 'aceptada');
    });

    it('a igual avance, el más reciente', () => {
      const rows = [
        service('aceptada', '2026-11-20T09:00:00Z'),
        service('aceptada', '2026-11-20T12:00:00Z'),
      ];
      assert.equal(pickActiveService(rows)?.label, 'aceptada-2026-11-20T12:00:00Z');
    });

    it('un en_curso antiguo pesa igual que en_camino', () => {
      const rows = [
        service('en_curso', '2026-11-20T09:00:00Z'),
        service('en_camino', '2026-11-20T10:00:00Z'),
      ];
      assert.equal(pickActiveService(rows)?.status, 'en_camino');
    });

    it('sin servicios activos devuelve null y no usa los terminados', () => {
      assert.equal(pickActiveService([]), null);
      assert.equal(
        pickActiveService([
          service('completada', '2026-11-20T09:00:00Z'),
          service('cancelada', '2026-11-20T10:00:00Z'),
        ]),
        null,
      );
    });

    it('el seguimiento y el chat dependen del estado', () => {
      assert.equal(canTrack('en_camino'), true);
      assert.equal(canTrack('en_curso'), true);
      assert.equal(canTrack('llegado'), true);
      assert.equal(canTrack('aceptada'), false);
      assert.equal(canTrack('completada'), false);

      assert.equal(canChat('aceptada', true), true);
      assert.equal(canChat('llegado', true), true);
      assert.equal(canChat('pendiente', false), false);
      assert.equal(canChat('aceptada', false), false);
      assert.equal(canChat('completada', true), false);
      assert.equal(canChat('cancelada', true), false);
    });
  });

  describe('paymentStatus', () => {
    const figures = (total: string | null, paid: string, pending = '0.00') => ({
      total,
      paid,
      pending_confirmation: pending,
    });

    it('pagado cuando lo confirmado cubre el total', () => {
      assert.equal(paymentStatus('completada', figures('350.00', '350.00')), 'pagado');
      assert.equal(paymentStatus('completada', figures('350.00', '400.00')), 'pagado');
    });

    it('parcial cuando hay pagos pero falta saldo', () => {
      assert.equal(paymentStatus('completada', figures('350.00', '100.00')), 'parcial');
    });

    it('por confirmar cuando el cliente registró un pago que el proveedor no confirma', () => {
      assert.equal(
        paymentStatus('completada', figures('350.00', '0.00', '350.00')),
        'por_confirmar',
      );
    });

    it('sin pago cuando aún no hay nada', () => {
      assert.equal(paymentStatus('completada', figures('350.00', '0.00')), 'sin_pago');
      assert.equal(paymentStatus('aceptada', figures(null, '0.00')), 'sin_pago');
    });

    it('cancelado o expirado no tiene pago que cobrar', () => {
      assert.equal(paymentStatus('cancelada', figures('350.00', '0.00')), 'no_aplica');
      assert.equal(paymentStatus('expirada', figures(null, '0.00')), 'no_aplica');
    });

    it('un total en cero no cuenta como pagado', () => {
      assert.equal(paymentStatus('completada', figures('0.00', '0.00')), 'sin_pago');
    });
  });

  describe('visibleCost', () => {
    it('finalizada: el total que se fijó al terminar', () => {
      assert.equal(visibleCost('completada', '420.00', '350.00'), '420.00');
    });

    it('finalizada sin total guardado usa el estimado', () => {
      assert.equal(visibleCost('completada', null, '350.00'), '350.00');
    });

    it('en curso o pendiente: el estimado', () => {
      assert.equal(visibleCost('aceptada', null, '350.00'), '350.00');
      assert.equal(visibleCost('pendiente', null, null), null);
    });

    it('cancelada o expirada: no se cobra', () => {
      assert.equal(visibleCost('cancelada', null, '350.00'), null);
      assert.equal(visibleCost('expirada', null, '350.00'), null);
    });
  });
});
