import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import {
  DOMAIN_EVENTS,
  ServiceRequestDispatchedEvent,
  ServiceRequestStatusChangedEvent,
} from '../events/domain-events.ts';
import {
  NotificationObserver,
  type NotificationRecord,
} from '../observers/notification.observer.ts';

describe('API-28: aviso de solicitud entrante al proveedor', () => {
  let bus: EventBus;
  let persisted: NotificationRecord[];
  let pushed: NotificationRecord[];
  let lookups: { employeeId: string | null; branchId: string }[];
  let recipients: string[];

  beforeEach(() => {
    bus = new EventBus();
    persisted = [];
    pushed = [];
    lookups = [];
    recipients = ['77', '88'];

    const observer = new NotificationObserver(
      async (record) => {
        persisted.push(record);
      },
      async (record) => {
        pushed.push(record);
      },
      async () => [],
      async () => false,
      async (target) => {
        lookups.push(target);
        return recipients;
      },
    );

    bus.register(DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED, observer);
    bus.register(DOMAIN_EVENTS.SERVICE_REQUEST_DISPATCHED, observer);
  });

  const created = (
    overrides: Partial<ConstructorParameters<typeof ServiceRequestStatusChangedEvent>[0]> = {},
  ) =>
    new ServiceRequestStatusChangedEvent({
      requestId: '15',
      fromStatus: null,
      toStatus: 'pendiente',
      changedBy: '303',
      clientId: '303',
      employeeId: null,
      branchId: '2',
      ...overrides,
    });

  it('una solicitud nueva avisa como alarma al personal de la sucursal y no al cliente', async () => {
    await bus.notify(created());

    assert.deepEqual(lookups, [{ employeeId: null, branchId: '2' }]);
    assert.deepEqual(
      pushed.map((record) => record.userId),
      ['77', '88'],
    );

    for (const record of pushed) {
      assert.equal(record.type, 'nueva_solicitud');
      assert.equal(record.entityType, 'service_request');
      assert.equal(record.entityId, '15');
      assert.equal(record.alarm, true);
    }

    assert.equal(persisted.length, 2);
    assert.ok(!pushed.some((record) => record.userId === '303'));
  });

  it('con técnico asignado se busca a ese técnico', async () => {
    recipients = ['91'];

    await bus.notify(created({ employeeId: '40' }));

    assert.deepEqual(lookups, [{ employeeId: '40', branchId: '2' }]);
    assert.deepEqual(
      pushed.map((record) => record.userId),
      ['91'],
    );
  });

  it('la de emergencia no avisa al crearse: avisa el despacho, también como alarma', async () => {
    await bus.notify(created({ branchId: null }));
    assert.equal(pushed.length, 0);

    await bus.notify(
      new ServiceRequestDispatchedEvent({
        requestId: '16',
        categoryId: '1',
        categoryName: 'Plomería',
        latitude: 19.43,
        longitude: -99.13,
        recipientUserIds: ['77'],
        employeeIds: ['40'],
        radiusKm: 5,
      }),
    );

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].type, 'solicitud_emergencia_disponible');
    assert.equal(pushed[0].alarm, true);
  });

  it('los cambios de estado al cliente siguen siendo notificaciones normales', async () => {
    await bus.notify(created({ fromStatus: 'pendiente', toStatus: 'aceptada' }));

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].userId, '303');
    assert.equal(pushed[0].alarm, undefined);
    assert.equal(lookups.length, 0);
  });
});
