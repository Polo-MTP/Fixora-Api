import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDatabase } from '../../config/database.ts';
import {
  categories,
  employees,
  notifications,
  price_adjustment,
  roles,
  service_payments,
  service_requests,
  users,
} from '../../database/schema/tables.ts';
import { eventBus } from '../../events/event-bus.ts';
import { DOMAIN_EVENTS, type DebtReminderPayload } from '../../events/events/domain-events.ts';
import type { DomainEvent } from '../../events/interfaces/domain-event.interface.ts';
import { summarizePayments } from '../payment.rules.ts';
import {
  listMyDebts,
  listMyPayments,
  listRequestPayments,
  registerPayment,
  respondPayment,
  validatePayment,
} from '../payment.service.ts';
import { DEBT_REMINDER_TYPE, sendDueDebtReminders } from '../debt-reminder.service.ts';

describe('API-37: reglas del pago', () => {
  it('resume lo pagado, lo que espera confirmación y lo que falta', () => {
    const summary = summarizePayments(
      '450.50',
      [
        { amount: '200.00', status: 'completado' },
        { amount: '100.00', status: 'pendiente' },
        { amount: '50.00', status: 'fallido' },
      ],
      true,
    );
    assert.deepEqual(summary, {
      total_amount: '450.50',
      paid: '200.00',
      pending_confirmation: '100.00',
      balance_due: '250.50',
      has_debt: true,
    });
    // Sin finalizar no es adeudo aunque falte pagar.
    assert.equal(summarizePayments('300.00', [], false).has_debt, false);
    assert.equal(
      summarizePayments('300.00', [{ amount: '300.00', status: 'completado' }], true).has_debt,
      false,
    );
  });

  it('valida el pago que registra el cliente', () => {
    assert.deepEqual(validatePayment({ method: 'efectivo' }), {
      method: 'efectivo',
      amountCents: null,
      reference: null,
      clientUuid: null,
    });
    assert.equal(
      validatePayment({ method: 'transferencia', amount: '99.9', reference: ' SPEI 123 ' })
        .reference,
      'SPEI 123',
    );
    assert.throws(() => validatePayment({ method: 'tarjeta' }), {
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
    for (const body of [
      {},
      { method: 'bitcoin' },
      { method: 'efectivo', amount: 0 },
      { method: 'efectivo', amount: '1.001' },
      { method: 'efectivo', status: 'completado' },
    ]) {
      assert.throws(() => validatePayment(body), { statusCode: 400 }, JSON.stringify(body));
    }
  });
});

describe('API-37: el cliente paga y el proveedor confirma', () => {
  const created: bigint[] = [];
  let requestId: bigint;
  let inProgressId: bigint;
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
    const [done] = await db
      .insert(service_requests)
      .values({
        ...base,
        description: 'Prueba de pagos',
        status: 'completada',
        total_amount: '450.50',
        arrived_at: new Date(),
        completed_at: new Date(),
      })
      .returning({ id: service_requests.UniqueID });
    const [arrived] = await db
      .insert(service_requests)
      .values({ ...base, description: 'Prueba de pagos sin finalizar', status: 'llegado' })
      .returning({ id: service_requests.UniqueID });
    requestId = done.id;
    inProgressId = arrived.id;
    created.push(done.id, arrived.id);
    await db.insert(price_adjustment).values({
      request_id: done.id,
      amount: '150.50',
      reason: 'materiales_extra',
      status: 'aprobado',
      declared_by: employee.userId,
    });
    ready = true;
  });

  after(async () => {
    if (created.length) {
      await db.delete(service_payments).where(inArray(service_payments.request_id, created));
      await db.delete(price_adjustment).where(inArray(price_adjustment.request_id, created));
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

  it('registra, rechaza, confirma y deja el adeudo en cero', async (t) => {
    if (!ready) {
      t.skip('La base local no tiene un cliente, una categoría y un técnico activo.');
      return;
    }

    // Solo se paga un servicio ya finalizado, y solo lo registra el cliente.
    await assert.rejects(registerPayment(inProgressId, client, { method: 'efectivo' }), {
      code: 'INVALID_REQUEST_STATUS',
    });
    await assert.rejects(registerPayment(requestId, technician, { method: 'efectivo' }), {
      statusCode: 403,
    });
    await assert.rejects(
      registerPayment(requestId, client, { method: 'efectivo', amount: '500' }),
      { code: 'AMOUNT_EXCEEDS_BALANCE' },
    );

    const first = await registerPayment(requestId, client, {
      method: 'transferencia',
      amount: '200',
      reference: 'SPEI 4821',
      client_uuid: 'pago-1',
    });
    assert.equal(first.created, true);
    assert.equal(first.payment.status, 'pendiente');
    const retry = await registerPayment(requestId, client, {
      method: 'transferencia',
      amount: '200',
      client_uuid: 'pago-1',
    });
    assert.equal(retry.created, false);
    assert.equal(retry.payment.id, first.payment.id);
    await assert.rejects(registerPayment(requestId, client, { method: 'efectivo' }), {
      code: 'PAYMENT_PENDING',
    });

    // El cliente no confirma su propio pago.
    await assert.rejects(
      respondPayment(requestId, BigInt(first.payment.id), client, 'completado', {}),
      { statusCode: 403 },
    );
    const confirmed = await respondPayment(
      requestId,
      BigInt(first.payment.id),
      technician,
      'completado',
      {},
    );
    assert.equal(confirmed.payment.status, 'completado');
    assert.ok(confirmed.payment.paid_at);
    assert.equal(confirmed.summary.balance_due, '250.50');
    assert.equal(confirmed.summary.has_debt, true);
    await assert.rejects(
      respondPayment(requestId, BigInt(first.payment.id), technician, 'completado', {}),
      { code: 'PAYMENT_ALREADY_RESPONDED' },
    );

    // Aparece como adeudo para los dos lados.
    const clientDebts = await listMyDebts(client);
    const debt = clientDebts.debts.find((item) => item.request_id === requestId.toString());
    assert.equal(debt?.balance_due, '250.50');
    const providerDebts = await listMyDebts(technician);
    assert.ok(providerDebts.debts.some((item) => item.request_id === requestId.toString()));

    // Sin monto paga todo lo que falta; el proveedor dice que no le llegó.
    const second = await registerPayment(requestId, client, { method: 'efectivo' });
    assert.equal(second.payment.amount, '250.50');
    const rejected = await respondPayment(
      requestId,
      BigInt(second.payment.id),
      technician,
      'fallido',
      { reason: 'No me llegó el efectivo completo' },
    );
    assert.equal(rejected.payment.status, 'fallido');
    assert.equal(rejected.payment.rejection_reason, 'No me llegó el efectivo completo');
    assert.equal(rejected.summary.balance_due, '250.50');

    const third = await registerPayment(requestId, client, { method: 'efectivo' });
    const paid = await respondPayment(
      requestId,
      BigInt(third.payment.id),
      technician,
      'completado',
      {},
    );
    assert.equal(paid.summary.balance_due, '0.00');
    assert.equal(paid.summary.has_debt, false);

    // Pagado todo: el ajuste aprobado queda como pagado y el total no cambia.
    const [adjustment] = await db
      .select()
      .from(price_adjustment)
      .where(eq(price_adjustment.request_id, requestId));
    assert.equal(adjustment.status, 'pagado');
    const detail = await listRequestPayments(requestId, client);
    assert.equal(detail.summary.total_amount, '450.50');
    assert.equal(detail.summary.paid, '450.50');
    assert.equal(detail.payments.length, 3);
    await assert.rejects(registerPayment(requestId, client, { method: 'efectivo' }), {
      code: 'NOTHING_TO_PAY',
    });
    assert.ok(
      !(await listMyDebts(client)).debts.some((item) => item.request_id === requestId.toString()),
    );

    const history = await listMyPayments(client, { page: 1, limit: 50 });
    assert.equal(history.data.filter((item) => item.request_id === requestId.toString()).length, 3);
  });

  it('recuerda el adeudo un día después y no repite el mismo día', async (t) => {
    if (!ready) {
      t.skip('La base local no tiene un cliente, una categoría y un técnico activo.');
      return;
    }
    const [source] = await db
      .select()
      .from(service_requests)
      .where(eq(service_requests.UniqueID, inProgressId));
    const [debtRequest] = await db
      .insert(service_requests)
      .values({
        client_id: source.client_id,
        category_id: source.category_id,
        branch_id: source.branch_id,
        employee_id: source.employee_id,
        description: 'Prueba de recordatorio de adeudo',
        status: 'llegado',
        agreed_price: '300.00',
      })
      .returning({ id: service_requests.UniqueID });
    created.push(debtRequest.id);
    const completedAt = new Date('2026-01-10T12:00:00Z');
    await db
      .update(service_requests)
      .set({ status: 'completada', total_amount: '300.00', completed_at: completedAt })
      .where(eq(service_requests.UniqueID, debtRequest.id));

    const reminders: DebtReminderPayload[] = [];
    const listener = {
      name: 'DebtReminderTestListener',
      handle: async (event: DomainEvent) => {
        reminders.push(event.payload as DebtReminderPayload);
      },
    };
    eventBus.register(DOMAIN_EVENTS.DEBT_REMINDER, listener);
    try {
      const mine = () => reminders.filter((item) => item.requestId === debtRequest.id.toString());

      // Antes de un día no se recuerda.
      await sendDueDebtReminders(new Date(completedAt.getTime() + 20 * 3_600_000));
      assert.equal(mine().length, 0);

      await sendDueDebtReminders(new Date(completedAt.getTime() + 25 * 3_600_000));
      assert.deepEqual(mine(), [
        { requestId: debtRequest.id.toString(), clientId: client.id, balanceDue: '300.00' },
      ]);

      // Ya se mandó uno hace una hora: hoy no se repite.
      await db.insert(notifications).values({
        user_id: BigInt(client.id),
        type: DEBT_REMINDER_TYPE,
        title: 'Tienes un pago pendiente',
        message: 'Prueba',
        entity_type: 'service_request',
        entity_id: debtRequest.id,
        created_at: new Date(completedAt.getTime() + 25 * 3_600_000),
      });
      await sendDueDebtReminders(new Date(completedAt.getTime() + 26 * 3_600_000));
      assert.equal(mine().length, 1);
    } finally {
      eventBus.unregister(DOMAIN_EVENTS.DEBT_REMINDER, listener.name);
    }
  });
});
