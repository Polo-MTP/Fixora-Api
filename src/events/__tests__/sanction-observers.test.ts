import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import {
  ReportStatusChangedEvent,
  SanctionAppliedEvent,
  SanctionLiftedEvent,
  type ReportStatusChangedPayload,
  type SanctionAppliedPayload,
  type SanctionKind,
} from '../events/domain-events.ts';
import {
  NotificationObserver,
  type NotificationRecord,
} from '../observers/notification.observer.ts';
import { HistoryObserver } from '../observers/history.observer.ts';
import { RealTimeObserver } from '../observers/realtime.observer.ts';
import { SanctionObserver } from '../observers/sanction.observer.ts';
import { setupDomainEventObservers } from '../index.ts';

describe('Observadores de sanciones (API-42)', () => {
  let bus: EventBus;
  let persisted: NotificationRecord[];
  let pushed: NotificationRecord[];
  let evaluated: ReportStatusChangedPayload[];

  beforeEach(() => {
    bus = new EventBus();
    persisted = [];
    pushed = [];
    evaluated = [];

    setupDomainEventObservers(bus, {
      notificationObserver: new NotificationObserver(
        async (record) => {
          persisted.push(record);
        },
        async (record) => {
          pushed.push(record);
        },
      ),
      historyObserver: new HistoryObserver(async () => {}),
      realtimeObserver: new RealTimeObserver(() => {}),
      sanctionObserver: new SanctionObserver(async (payload) => {
        evaluated.push(payload);
      }),
    });
  });

  const reportEvent = (toStatus: string, fromStatus: string | null = 'en_revision') =>
    new ReportStatusChangedEvent({
      reportId: '45',
      reporterId: '303',
      fromStatus,
      toStatus,
      changedBy: '999',
      category: 'conducta_inapropiada',
      folio: 'REP-2026-000045',
      alreadyLogged: true,
    });

  describe('regla automática', () => {
    it('evalúa la marca cuando un reporte queda resuelto', async () => {
      await bus.notify(reportEvent('resuelto'));
      assert.equal(evaluated.length, 1);
      assert.equal(evaluated[0]!.reportId, '45');
      assert.equal(evaluated[0]!.changedBy, '999');
    });

    it('no evalúa con otros estados: solo cuenta lo confirmado', async () => {
      await bus.notify(reportEvent('en_revision', 'pendiente'));
      await bus.notify(reportEvent('rechazado'));
      await bus.notify(reportEvent('pendiente', null));
      assert.equal(evaluated.length, 0);
    });

    it('un fallo al evaluar no tumba al emisor: el bus lo cuenta como fallo', async () => {
      const failingBus = new EventBus();
      failingBus.register(
        'report.status_changed',
        new SanctionObserver(async () => {
          throw new Error('base de datos no disponible');
        }),
      );
      const summary = await failingBus.notify(reportEvent('resuelto'));
      assert.equal(summary.failed, 1);
      assert.equal(summary.errors[0]!.observerName, 'SanctionObserver');
    });
  });

  describe('avisos a la persona sancionada', () => {
    const applied = (type: SanctionKind, overrides: Partial<SanctionAppliedPayload> = {}) =>
      new SanctionAppliedEvent({
        sanctionId: '7',
        userId: '20',
        type,
        reason: 'Cancelaciones repetidas',
        endsAt: '2026-12-01T18:00:00.000Z',
        source: 'manual',
        appliedBy: '999',
        reportId: null,
        ...overrides,
      });

    it('una restricción temporal avisa hasta cuándo no puede crear solicitudes', async () => {
      await bus.notify(applied('restriccion_temporal'));

      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]!.userId, '20');
      assert.equal(persisted[0]!.type, 'sancion');
      assert.equal(persisted[0]!.entityType, 'sanction');
      assert.equal(persisted[0]!.entityId, '7');
      assert.match(persisted[0]!.message, /No podrás crear solicitudes nuevas hasta el .*2026/);
      assert.match(persisted[0]!.message, /Cancelaciones repetidas/);
      assert.equal(pushed.length, 1);
    });

    it('una baja de reputación también avisa', async () => {
      await bus.notify(applied('baja_reputacion', { endsAt: null }));
      assert.equal(persisted.length, 1);
      assert.match(persisted[0]!.message, /baja reputación/);
    });

    it('la marca de usuario problemático es interna: no avisa a nadie', async () => {
      await bus.notify(applied('usuario_problematico', { endsAt: null, source: 'automatica' }));
      assert.equal(persisted.length, 0);
      assert.equal(pushed.length, 0);
    });

    it('al retirar una restricción avisa que ya puede crear solicitudes', async () => {
      await bus.notify(
        new SanctionLiftedEvent({
          sanctionId: '7',
          userId: '20',
          type: 'restriccion_temporal',
          liftedBy: '999',
          reason: 'Se revisó el caso',
        }),
      );
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]!.message, 'Ya puedes crear solicitudes nuevas.');
    });

    it('al retirar una marca interna no avisa', async () => {
      await bus.notify(
        new SanctionLiftedEvent({
          sanctionId: '8',
          userId: '20',
          type: 'usuario_problematico',
          liftedBy: '999',
          reason: 'Se revisó el caso',
        }),
      );
      assert.equal(persisted.length, 0);
    });
  });
});
