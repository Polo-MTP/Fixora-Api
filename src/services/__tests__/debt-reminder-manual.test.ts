import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDatabase } from '../../config/database.ts';
import {
  categories,
  employees,
  income_records,
  notifications,
  roles,
  service_payments,
  service_requests,
  users,
} from '../../database/schema/tables.ts';
import { eventBus } from '../../events/event-bus.ts';
import { DOMAIN_EVENTS, type DebtReminderPayload } from '../../events/events/domain-events.ts';
import type { DomainEvent } from '../../events/interfaces/domain-event.interface.ts';
import { DEBT_REMINDER_TYPE, nextReminderAllowedAt } from '../debt-reminder.service.ts';
import {
  listMyDebts,
  registerPayment,
  respondPayment,
  sendManualDebtReminder,
} from '../payment.service.ts';

describe('API-53: cuándo se puede volver a recordar', () => {
  it('se puede de inmediato sin recordatorios y 24 horas después del último', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    assert.equal(nextReminderAllowedAt(undefined, now), null);
    assert.deepEqual(
      nextReminderAllowedAt(new Date('2026-11-23T10:00:00Z'), now),
      new Date('2026-11-24T10:00:00Z'),
    );
    assert.equal(nextReminderAllowedAt(new Date('2026-11-22T11:00:00Z'), now), null);
  });
});

describe('API-53: el proveedor le recuerda un adeudo al cliente', () => {
  const created: bigint[] = [];
  let debtId: bigint;
  let openId: bigint;
  let client: { id: string; role: string };
  let technician: { id: string; role: string };
  let ready = false;

  before(async () => {
    const [clientRow] = await db
      .select({ id: users.UniqueID })
      .from(users)
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(eq(roles.name, 'cliente'))
      .limit(1);
    const [category] = await db.select({ id: categories.UniqueID }).from(categories).limit(1);
    const [employee] = await db
      .select({ id: employees.UniqueID, userId: employees.user_id, branchId: employees.branch_id })
      .from(employees)
      .where(eq(employees.active, true))
      .limit(1);
    if (!clientRow || !category || !employee) return;

    client = { id: clientRow.id.toString(), role: 'cliente' };
    technician = { id: employee.userId.toString(), role: 'empleado' };
    const base = {
      client_id: clientRow.id,
      category_id: category.id,
      branch_id: employee.branchId,
      employee_id: employee.id,
      agreed_price: '300.00',
      accepted_at: new Date(),
    };
    const [debt] = await db
      .insert(service_requests)
      .values({
        ...base,
        description: 'Prueba de recordatorio manual',
        status: 'completada',
        total_amount: '300.00',
        completed_at: new Date(),
      })
      .returning({ id: service_requests.UniqueID });
    const [open] = await db
      .insert(service_requests)
      .values({ ...base, description: 'Prueba de recordatorio sin finalizar', status: 'llegado' })
      .returning({ id: service_requests.UniqueID });
    debtId = debt.id;
    openId = open.id;
    created.push(debt.id, open.id);
    ready = true;
  });

  after(async () => {
    if (created.length) {
      await db.delete(income_records).where(inArray(income_records.request_id, created));
      await db.delete(service_payments).where(inArray(service_payments.request_id, created));
      await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.entity_type, 'service_request'),
            inArray(notifications.entity_id, created),
          ),
        );
      await db.delete(service_requests).where(inArray(service_requests.UniqueID, created));
    }
    await closeDatabase();
  });

  it('manda el recordatorio, respeta las 24 horas y no insiste con un pago por confirmar', async (t) => {
    if (!ready) {
      t.skip('La base local no tiene un cliente, una categoría y un técnico activo.');
      return;
    }
    const reminders: DebtReminderPayload[] = [];
    const listener = {
      name: 'ManualDebtReminderTestListener',
      handle: async (event: DomainEvent) => {
        reminders.push(event.payload as DebtReminderPayload);
      },
    };
    eventBus.register(DOMAIN_EVENTS.DEBT_REMINDER, listener);
    try {
      // Solo el proveedor recuerda, y solo servicios finalizados con saldo.
      await assert.rejects(sendManualDebtReminder(debtId, client), { statusCode: 403 });
      await assert.rejects(sendManualDebtReminder(openId, technician), { code: 'NO_DEBT' });

      const sent = await sendManualDebtReminder(debtId, technician);
      assert.equal(sent.balance_due, '300.00');
      assert.ok(sent.next_reminder_at);
      assert.deepEqual(
        reminders.filter((item) => item.requestId === debtId.toString()),
        [{ requestId: debtId.toString(), clientId: client.id, balanceDue: '300.00' }],
      );

      // El aviso queda guardado como notificación (en la app lo guarda su observador).
      await db.insert(notifications).values({
        user_id: BigInt(client.id),
        type: DEBT_REMINDER_TYPE,
        title: 'Tienes un pago pendiente',
        message: 'Prueba',
        entity_type: 'service_request',
        entity_id: debtId,
      });
      await assert.rejects(sendManualDebtReminder(debtId, technician), {
        code: 'REMINDER_TOO_SOON',
      });

      // En la lista de adeudos el proveedor ve que ya se recordó y desde cuándo puede otra vez.
      const debts = await listMyDebts(technician);
      const debt = debts.debts.find((item) => item.request_id === debtId.toString());
      assert.equal(debt?.reminders_sent, 1);
      assert.ok(debt?.last_reminder_at);
      assert.ok(debt?.next_reminder_at);

      // Con un pago esperando confirmación no se le insiste al cliente.
      await db
        .delete(notifications)
        .where(
          and(eq(notifications.type, DEBT_REMINDER_TYPE), eq(notifications.entity_id, debtId)),
        );
      const payment = await registerPayment(debtId, client, { method: 'efectivo' });
      await assert.rejects(sendManualDebtReminder(debtId, technician), {
        code: 'PAYMENT_PENDING_CONFIRMATION',
      });

      // Ya pagado, no hay nada que recordar.
      await respondPayment(debtId, BigInt(payment.payment.id), technician, 'completado', {});
      await assert.rejects(sendManualDebtReminder(debtId, technician), { code: 'NO_DEBT' });
    } finally {
      eventBus.unregister(DOMAIN_EVENTS.DEBT_REMINDER, listener.name);
    }
  });
});
