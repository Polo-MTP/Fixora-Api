import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import {
  ReportCommentAddedEvent,
  ReportStatusChangedEvent,
  type ReportCommentAddedPayload,
} from '../events/domain-events.ts';
import {
  NotificationObserver,
  type NotificationRecord,
} from '../observers/notification.observer.ts';
import { HistoryObserver, type HistoryEntry } from '../observers/history.observer.ts';
import { RealTimeObserver, type RealTimeMessage } from '../observers/realtime.observer.ts';
import { setupDomainEventObservers } from '../index.ts';

describe('Observadores de reportes con bitácora (API-40)', () => {
  let bus: EventBus;
  let persisted: NotificationRecord[];
  let pushed: NotificationRecord[];
  let history: HistoryEntry[];
  let realTime: RealTimeMessage[];

  beforeEach(() => {
    bus = new EventBus();
    persisted = [];
    pushed = [];
    history = [];
    realTime = [];

    setupDomainEventObservers(bus, {
      notificationObserver: new NotificationObserver(
        async (record) => {
          persisted.push(record);
        },
        async (record) => {
          pushed.push(record);
        },
      ),
      historyObserver: new HistoryObserver(async (entry) => {
        history.push(entry);
      }),
      realtimeObserver: new RealTimeObserver((message) => {
        realTime.push(message);
      }),
    });
  });

  const channels = () => realTime.map((message) => message.channel);

  describe('alta del reporte', () => {
    const created = () =>
      new ReportStatusChangedEvent({
        reportId: '45',
        reporterId: '303',
        fromStatus: null,
        toStatus: 'pendiente',
        changedBy: '303',
        category: 'servicio_incompleto',
        folio: 'REP-2026-000045',
        reportType: 'reporte',
        alreadyLogged: true,
      });

    it('manda a quien reportó un acuse con el folio, guardado y en push', async () => {
      await bus.notify(created());

      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]!.userId, '303');
      assert.match(persisted[0]!.message, /Recibimos tu reporte REP-2026-000045/);
      assert.match(persisted[0]!.title, /REP-2026-000045/);
      assert.equal(pushed.length, 1);
    });

    it('avisa a Soporte y a quien reportó en tiempo real, con el folio', async () => {
      await bus.notify(created());

      assert.ok(channels().includes('admin:reports'));
      assert.ok(channels().includes('users:303'));
      const update = realTime.find((message) => message.channel === 'admin:reports');
      assert.equal((update?.data as { folio: string }).folio, 'REP-2026-000045');
    });

    it('no repite la bitácora que el servicio ya guardó en su transacción', async () => {
      await bus.notify(created());
      assert.equal(history.length, 0);
    });
  });

  describe('cambio de estado', () => {
    it('avisa con el folio cuando se resuelve', async () => {
      await bus.notify(
        new ReportStatusChangedEvent({
          reportId: '45',
          reporterId: '303',
          fromStatus: 'en_revision',
          toStatus: 'resuelto',
          changedBy: '999',
          category: 'cobro_indebido',
          resolutionType: 'reembolso',
          comment: 'Se reembolsó el cobro.',
          folio: 'REP-2026-000045',
          alreadyLogged: true,
        }),
      );

      assert.match(persisted[0]!.message, /REP-2026-000045 ha sido resuelto \(reembolso\)/);
      assert.equal(pushed.length, 1);
      assert.equal(history.length, 0);
    });

    it('sin alreadyLogged conserva el comportamiento anterior: la bitácora la guarda el observador', async () => {
      await bus.notify(
        new ReportStatusChangedEvent({
          reportId: '900',
          reporterId: '303',
          fromStatus: 'pendiente',
          toStatus: 'en_revision',
          changedBy: '999',
          category: 'otro',
        }),
      );

      assert.equal(history.length, 1);
      assert.equal(history[0]!.category, 'report');
      assert.match(persisted[0]!.message, /#900/);
    });
  });

  describe('comentarios en la bitácora', () => {
    const comment = (overrides: Partial<ReportCommentAddedPayload> = {}) =>
      new ReportCommentAddedEvent({
        reportId: '45',
        folio: 'REP-2026-000045',
        reporterId: '303',
        authorId: '999',
        authorIsStaff: true,
        internal: false,
        preview: 'Ya revisamos tu evidencia.',
        ...overrides,
      });

    it('un comentario de Soporte avisa a quien reportó', async () => {
      await bus.notify(comment());

      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]!.userId, '303');
      assert.equal(persisted[0]!.message, 'Ya revisamos tu evidencia.');
      assert.equal(pushed.length, 1);
      assert.ok(channels().includes('users:303'));
      assert.ok(channels().includes('reports:45'));
    });

    it('una nota interna no avisa a nadie y solo llega a Soporte sin el texto', async () => {
      await bus.notify(comment({ internal: true, preview: 'Posible fraude' }));

      assert.equal(persisted.length, 0);
      assert.equal(pushed.length, 0);
      assert.deepEqual(channels(), ['admin:reports']);
      assert.equal((realTime[0]!.data as { preview: string | null }).preview, null);
    });

    it('un comentario de quien reportó llega a Soporte, sin aviso a quien reportó', async () => {
      await bus.notify(
        comment({ authorId: '303', authorIsStaff: false, preview: 'Adjunto más fotos' }),
      );

      assert.equal(persisted.length, 0);
      assert.ok(channels().includes('admin:reports'));
      assert.ok(!channels().includes('users:303'));
    });
  });
});
