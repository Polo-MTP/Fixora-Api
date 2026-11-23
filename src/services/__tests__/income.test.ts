import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDatabase } from '../../config/database.ts';
import {
  categories,
  commission_settings,
  employees,
  income_records,
  notifications,
  roles,
  service_payments,
  service_requests,
  users,
} from '../../database/schema/tables.ts';
import { commissionStatusFor, currentCommission, splitCommission } from '../income.rules.ts';
import {
  getCommissionSettings,
  listIncome,
  markCommissionPaid,
  setCommissionPercentage,
} from '../admin-income.service.ts';
import { registerPayment, respondPayment } from '../payment.service.ts';

describe('API-38: reglas de la comisión', () => {
  it('reparte el pago en comisión y neto, redondeando al centavo', () => {
    assert.deepEqual(splitCommission('450.50', '10.00'), {
      gross: '450.50',
      commission: '45.05',
      net: '405.45',
    });
    // 99.99 × 12.5 % = 12.49875 → 12.50
    assert.deepEqual(splitCommission('99.99', '12.5'), {
      gross: '99.99',
      commission: '12.50',
      net: '87.49',
    });
    assert.deepEqual(splitCommission('300', '0'), {
      gross: '300.00',
      commission: '0.00',
      net: '300.00',
    });
  });

  it('en efectivo o transferencia el proveedor debe la comisión', () => {
    assert.equal(commissionStatusFor('efectivo'), 'pendiente');
    assert.equal(commissionStatusFor('transferencia'), 'pendiente');
    assert.equal(commissionStatusFor('tarjeta'), 'pagada');
  });
});

describe('API-38: ingresos al confirmar pagos', () => {
  const requests: bigint[] = [];
  const settings: bigint[] = [];
  let requestId: bigint;
  let branchId: bigint;
  let adminId: string;
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
    adminId = employee.userId.toString();
    branchId = employee.branchId;
    const [request] = await db
      .insert(service_requests)
      .values({
        client_id: clientRow.id,
        category_id: category.id,
        branch_id: employee.branchId,
        employee_id: employee.id,
        description: 'Prueba de ingresos',
        status: 'completada',
        agreed_price: '300.00',
        total_amount: '300.00',
        accepted_at: new Date(),
        completed_at: new Date(),
      })
      .returning({ id: service_requests.UniqueID });
    requestId = request.id;
    requests.push(request.id);
    // Porcentaje fijo para la prueba, sin depender de lo que haya configurado la base local.
    const [setting] = await db
      .insert(commission_settings)
      .values({
        percentage: '12.00',
        effective_from: new Date(Date.now() - 1_000),
        created_by: employee.userId,
      })
      .returning({ id: commission_settings.UniqueID });
    settings.push(setting.id);
    ready = true;
  });

  after(async () => {
    if (requests.length) {
      await db.delete(income_records).where(inArray(income_records.request_id, requests));
      await db.delete(service_payments).where(inArray(service_payments.request_id, requests));
      await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.entity_type, 'service_request'),
            inArray(notifications.entity_id, requests),
          ),
        );
      await db.delete(service_requests).where(inArray(service_requests.UniqueID, requests));
    }
    if (settings.length) {
      await db.delete(commission_settings).where(inArray(commission_settings.UniqueID, settings));
    }
    await closeDatabase();
  });

  it('crea el ingreso con la comisión vigente y el Administrador lo liquida', async (t) => {
    if (!ready) {
      t.skip('La base local no tiene un cliente, una categoría y un técnico activo.');
      return;
    }

    const registered = await registerPayment(requestId, client, {
      method: 'efectivo',
      amount: '200',
    });
    // Un pago sin confirmar todavía no es ingreso.
    let rows = await db
      .select()
      .from(income_records)
      .where(eq(income_records.request_id, requestId));
    assert.equal(rows.length, 0);

    await respondPayment(requestId, BigInt(registered.payment.id), technician, 'completado', {});
    rows = await db.select().from(income_records).where(eq(income_records.request_id, requestId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gross_amount, '200.00');
    assert.equal(rows[0].commission_amount, '24.00');
    assert.equal(rows[0].net_amount, '176.00');
    assert.equal(rows[0].commission_status, 'pendiente');
    assert.equal(rows[0].branch_id, branchId);

    // Un pago rechazado no genera ingreso.
    const second = await registerPayment(requestId, client, { method: 'transferencia' });
    await respondPayment(requestId, BigInt(second.payment.id), technician, 'fallido', {});
    rows = await db.select().from(income_records).where(eq(income_records.request_id, requestId));
    assert.equal(rows.length, 1);

    const listed = await listIncome({
      branch_id: branchId.toString(),
      commission_status: 'pendiente',
      limit: 100,
    });
    const mine = listed.data.find((item) => item.request_id === requestId.toString());
    assert.equal(mine?.commission_amount, '24.00');
    assert.ok(mine?.branch_name);
    assert.ok(Number(listed.totals.commission_pending) >= 24);
    await assert.rejects(listIncome({ commission_status: 'debe' }), { statusCode: 400 });
    await assert.rejects(listIncome({ from: '22-11-2026' }), { statusCode: 400 });

    const paid = await markCommissionPaid(rows[0].UniqueID);
    assert.equal(paid.commission_status, 'pagada');
    assert.equal(paid.status, 'liquidado');
    assert.ok(paid.commission_paid_at);
    await assert.rejects(markCommissionPaid(rows[0].UniqueID), {
      code: 'COMMISSION_ALREADY_PAID',
    });
    const stillPending = await listIncome({
      branch_id: branchId.toString(),
      commission_status: 'pendiente',
      limit: 100,
    });
    assert.ok(!stillPending.data.some((item) => item.request_id === requestId.toString()));
  });

  it('el Administrador cambia el porcentaje desde ahora', async (t) => {
    if (!ready) {
      t.skip('La base local no tiene un cliente, una categoría y un técnico activo.');
      return;
    }
    const admin = { id: adminId, role: 'administrador' };
    for (const percentage of ['60', '7.555', -1, 'diez']) {
      await assert.rejects(setCommissionPercentage(admin, { percentage }), { statusCode: 400 });
    }
    await assert.rejects(setCommissionPercentage(admin, { percentage: 8, extra: 1 }), {
      statusCode: 400,
    });

    const created = await setCommissionPercentage(admin, { percentage: '8.5' });
    settings.push(BigInt(created.id));
    assert.equal(created.percentage, '8.50');
    assert.equal((await currentCommission(db)).percentage, '8.50');

    const overview = await getCommissionSettings();
    assert.equal(overview.current.percentage, '8.50');
    assert.equal(overview.current.is_default, false);
    assert.equal(overview.history[0].id, created.id);
  });
});
