import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import {
  DebtReminderEvent,
  PaymentRegisteredEvent,
  PaymentRespondedEvent,
  PriceAdjustmentProposedEvent,
  PriceAdjustmentRespondedEvent,
  ServiceRequestStatusChangedEvent,
  ReportStatusChangedEvent,
  SupplierVerificationEvent,
} from '../events/domain-events.ts';
import {
  NotificationObserver,
  type NotificationRecord,
} from '../observers/notification.observer.ts';
import { HistoryObserver, type HistoryEntry } from '../observers/history.observer.ts';
import { RealTimeObserver, type RealTimeMessage } from '../observers/realtime.observer.ts';
import { setupDomainEventObservers } from '../index.ts';

describe('Observadores desacoplados de dominio', () => {
  let bus: EventBus;
  let notificationRecords: NotificationRecord[];
  let historyEntries: HistoryEntry[];
  let realTimeMessages: RealTimeMessage[];

  let notificationObserver: NotificationObserver;
  let historyObserver: HistoryObserver;
  let realTimeObserver: RealTimeObserver;

  beforeEach(() => {
    bus = new EventBus();
    notificationRecords = [];
    historyEntries = [];
    realTimeMessages = [];

    // Inyectamos persisters en memoria para pruebas unitarias sin dependencias externas
    notificationObserver = new NotificationObserver(async (record) => {
      notificationRecords.push(record);
    });

    historyObserver = new HistoryObserver(async (entry) => {
      historyEntries.push(entry);
    });

    realTimeObserver = new RealTimeObserver((msg) => {
      realTimeMessages.push(msg);
    });

    setupDomainEventObservers(bus, {
      notificationObserver,
      historyObserver,
      realtimeObserver: realTimeObserver,
    });
  });

  describe('Evento: Cambio de estado de Solicitud de Servicio (Módulo 5)', () => {
    it('debe notificar al cliente, registrar historial auditable y emitir en tiempo real', async () => {
      const event = new ServiceRequestStatusChangedEvent({
        requestId: '101',
        fromStatus: 'pendiente',
        toStatus: 'en_curso',
        changedBy: '202',
        clientId: '303',
        employeeId: '404',
        branchId: '505',
        latitude: 19.4326,
        longitude: -99.1332,
      });

      const summary = await bus.notify(event);

      assert.equal(summary.totalObservers, 3);
      assert.equal(summary.succeeded, 3);
      assert.equal(summary.failed, 0);

      // 1. Notificación generada
      assert.equal(notificationRecords.length, 1);
      const notif = notificationRecords[0];
      assert.equal(notif.userId, '303');
      // API-25: el tipo indica el estado al que pasó la solicitud.
      assert.equal(notif.type, 'solicitud_en_curso');
      assert.equal(notif.entityId, '101');
      assert.match(notif.message, /en camino o atendiendo/);

      // 2. Historial de eventos de servicio
      assert.equal(historyEntries.length, 1);
      const history = historyEntries[0];
      assert.equal(history.category, 'service_request');
      assert.equal(history.aggregateId, '101');
      assert.equal(history.fromStatus, 'pendiente');
      assert.equal(history.toStatus, 'en_curso');
      assert.equal(history.changedBy, '202');
      assert.equal(history.details?.latitude, 19.4326);
      assert.equal(history.details?.longitude, -99.1332);

      // 3. Emisión en tiempo real
      assert.equal(realTimeMessages.length, 3);
      const channels = realTimeMessages.map((m) => m.channel);
      assert.ok(channels.includes('requests:101'));
      assert.ok(channels.includes('users:303'));
      assert.ok(channels.includes('technicians:404'));

      const reqMsg = realTimeMessages.find((m) => m.channel === 'requests:101');
      assert.equal(reqMsg?.event, 'service_request_updated');
      assert.deepEqual(reqMsg?.data, {
        requestId: '101',
        status: 'en_curso',
        previousStatus: 'pendiente',
        latitude: 19.4326,
        longitude: -99.1332,
      });
    });
  });

  describe('Evento: Cambio de estado de Reporte (Módulo 7)', () => {
    it('debe notificar al reportero, auditar el reporte y emitir a soporte en tiempo real', async () => {
      const event = new ReportStatusChangedEvent({
        reportId: '900',
        reporterId: '303',
        fromStatus: 'en_revision',
        toStatus: 'resuelto',
        changedBy: '999',
        category: 'servicio_incompleto',
        resolutionType: 'reembolso',
        comment: 'Se aprobó el reembolso por servicio no finalizado.',
      });

      const summary = await bus.notify(event);

      assert.equal(summary.totalObservers, 4);
      assert.equal(summary.succeeded, 4);
      assert.equal(summary.failed, 0);

      // 1. Notificación
      assert.equal(notificationRecords.length, 1);
      assert.equal(notificationRecords[0].userId, '303');
      assert.equal(notificationRecords[0].entityType, 'report');
      assert.match(notificationRecords[0].message, /ha sido resuelto/);

      // 2. Historial
      assert.equal(historyEntries.length, 1);
      assert.equal(historyEntries[0].category, 'report');
      assert.equal(historyEntries[0].aggregateId, '900');
      assert.equal(historyEntries[0].toStatus, 'resuelto');
      assert.equal(historyEntries[0].details?.resolutionType, 'reembolso');

      // 3. Tiempo real a admin y usuario
      const channels = realTimeMessages.map((m) => m.channel);
      assert.ok(channels.includes('reports:900'));
      assert.ok(channels.includes('users:303'));
      assert.ok(channels.includes('admin:reports'));
    });
  });

  describe('Evento: Verificación de Proveedor (Módulos 1 y 4)', () => {
    it('debe notificar al proveedor sobre aprobación y registrar validación documental', async () => {
      const event = new SupplierVerificationEvent({
        supplierId: '801',
        userId: '150',
        documentId: '65',
        result: 'aprobado',
        reviewedBy: '999',
        comment: 'Documentos oficiales vigentes y legibles.',
      });

      const summary = await bus.notify(event);
      assert.equal(summary.succeeded, 3);

      // 1. Notificación
      assert.equal(notificationRecords.length, 1);
      assert.equal(notificationRecords[0].userId, '150');
      assert.equal(notificationRecords[0].title, 'Verificación Aprobada');
      assert.match(notificationRecords[0].message, /aprobados/);

      // 2. Historial
      assert.equal(historyEntries.length, 1);
      assert.equal(historyEntries[0].category, 'supplier_verification');
      assert.equal(historyEntries[0].aggregateId, '801');
      assert.equal(historyEntries[0].details?.documentId, '65');

      // 3. Tiempo real
      const channels = realTimeMessages.map((m) => m.channel);
      assert.ok(channels.includes('users:150'));
      assert.ok(channels.includes('admin:verifications'));
    });
  });

  describe('Evento: Ajustes de precio (API-36)', () => {
    it('avisa al cliente cuando el técnico propone y al técnico cuando el cliente responde', async () => {
      await bus.notify(
        new PriceAdjustmentProposedEvent({
          requestId: '61',
          adjustmentId: '5',
          clientId: '29',
          employeeId: '2',
          amount: '150.50',
          reason: 'materiales_extra',
          description: 'Codo y cinta',
        }),
      );
      assert.equal(notificationRecords.length, 1);
      assert.equal(notificationRecords[0].userId, '29');
      assert.equal(notificationRecords[0].type, 'ajuste_precio_propuesto');
      assert.match(notificationRecords[0].message, /150\.50/);
      assert.deepEqual(
        realTimeMessages.map((m) => m.channel),
        ['requests:61', 'users:29', 'technicians:2'],
      );
      assert.ok(realTimeMessages.every((m) => m.event === 'price_adjustment_updated'));
      // No es un cambio de estado: no entra al historial de la solicitud.
      assert.equal(historyEntries.length, 0);

      await bus.notify(
        new PriceAdjustmentRespondedEvent({
          requestId: '61',
          adjustmentId: '5',
          clientId: '29',
          employeeId: '2',
          technicianUserIds: ['9'],
          amount: '150.50',
          decision: 'aprobado',
        }),
      );
      assert.equal(notificationRecords[1].userId, '9');
      assert.equal(notificationRecords[1].type, 'ajuste_precio_aprobado');
      assert.equal((realTimeMessages.at(-1)?.data as { status: string }).status, 'aprobado');
    });
  });

  describe('Evento: Pagos y adeudos (API-37)', () => {
    it('pide al proveedor confirmar y avisa al cliente cómo quedó su pago', async () => {
      await bus.notify(
        new PaymentRegisteredEvent({
          requestId: '61',
          paymentId: '3',
          clientId: '29',
          employeeId: '2',
          providerUserIds: ['9'],
          amount: '200.00',
          method: 'transferencia',
        }),
      );
      assert.equal(notificationRecords[0].userId, '9');
      assert.equal(notificationRecords[0].type, 'pago_registrado');
      assert.match(notificationRecords[0].message, /200\.00 por transferencia/);
      assert.ok(realTimeMessages.every((m) => m.event === 'payment_updated'));

      await bus.notify(
        new PaymentRespondedEvent({
          requestId: '61',
          paymentId: '3',
          clientId: '29',
          employeeId: '2',
          branchId: '2',
          amount: '200.00',
          method: 'transferencia',
          decision: 'completado',
          reason: null,
          balanceDue: '250.50',
        }),
      );
      assert.equal(notificationRecords[1].userId, '29');
      assert.equal(notificationRecords[1].type, 'pago_confirmado');
      assert.match(notificationRecords[1].message, /quedan \$250\.50/);

      await bus.notify(
        new PaymentRespondedEvent({
          requestId: '61',
          paymentId: '4',
          clientId: '29',
          employeeId: '2',
          branchId: '2',
          amount: '250.50',
          method: 'efectivo',
          decision: 'fallido',
          reason: 'No me llegó',
          balanceDue: '250.50',
        }),
      );
      assert.equal(notificationRecords[2].type, 'pago_rechazado');
      assert.match(notificationRecords[2].message, /No me llegó/);

      await bus.notify(
        new DebtReminderEvent({ requestId: '61', clientId: '29', balanceDue: '250.50' }),
      );
      assert.equal(notificationRecords[3].type, 'recordatorio_adeudo');
      // Ningún pago cambia el estado de la solicitud: no entra al historial.
      assert.equal(historyEntries.length, 0);
    });
  });
});
