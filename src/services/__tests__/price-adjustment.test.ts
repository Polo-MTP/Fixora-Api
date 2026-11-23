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
  service_request_events,
  service_requests,
  users,
} from '../../database/schema/tables.ts';
import {
  computeTotalAmount,
  parseAmountToCents,
  centsToAmount,
} from '../price-adjustment.rules.ts';
import {
  listPriceAdjustments,
  proposePriceAdjustment,
  respondPriceAdjustment,
  validateProposal,
} from '../price-adjustment.service.ts';
import { advanceServiceRequestStatus } from '../service-request-status.service.ts';

describe('API-36: reglas del precio', () => {
  it('lee montos con hasta 2 decimales y los regresa con 2', () => {
    assert.equal(parseAmountToCents('350'), 35_000);
    assert.equal(parseAmountToCents('150.5'), 15_050);
    assert.equal(parseAmountToCents(99.99), 9_999);
    assert.equal(parseAmountToCents('1.234'), null);
    assert.equal(parseAmountToCents('-5'), null);
    assert.equal(parseAmountToCents('abc'), null);
    assert.equal(centsToAmount(45_050), '450.50');
    assert.equal(centsToAmount(7), '0.07');
  });

  it('el total es el precio acordado más los ajustes aprobados', () => {
    assert.equal(computeTotalAmount('300.00', ['150.50', '49.50']), '500.00');
    assert.equal(computeTotalAmount('300.00', []), '300.00');
    // Una emergencia sin precio acordado todavía no suma base.
    assert.equal(computeTotalAmount(null, ['80']), '80.00');
  });

  it('valida la propuesta del técnico', () => {
    assert.deepEqual(validateProposal({ amount: '120.5', reason: 'materiales_extra' }), {
      amountCents: 12_050,
      reason: 'materiales_extra',
      description: null,
      clientUuid: null,
    });
    for (const body of [
      { amount: 0, reason: 'materiales_extra' },
      { amount: '10.999', reason: 'materiales_extra' },
      { amount: '50000.01', reason: 'materiales_extra' },
      { amount: 100, reason: 'propina' },
      { amount: 100, reason: 'otro' },
      { amount: 100, reason: 'otro', description: '   ' },
      { amount: 100, reason: 'materiales_extra', total: 1 },
    ]) {
      assert.throws(() => validateProposal(body), { statusCode: 400 }, JSON.stringify(body));
    }
    assert.equal(
      validateProposal({ amount: 100, reason: 'otro', description: ' Cambio de llave ' })
        .description,
      'Cambio de llave',
    );
  });
});

describe('API-36: el técnico propone y el cliente aprueba', () => {
  const created: bigint[] = [];
  let requestId: bigint;
  let client: { id: string; role: string };
  let otherClient: { id: string; role: string };
  let technician: { id: string; role: string };
  let ready = false;

  before(async () => {
    const clients = await db
      .select({ id: users.UniqueID })
      .from(users)
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(eq(roles.name, 'cliente'))
      .limit(2);
    const [category] = await db.select({ id: categories.UniqueID }).from(categories).limit(1);
    const [employee] = await db
      .select({ id: employees.UniqueID, userId: employees.user_id, branchId: employees.branch_id })
      .from(employees)
      .where(eq(employees.active, true))
      .limit(1);
    if (clients.length < 2 || !category || !employee) return;

    client = { id: clients[0].id.toString(), role: 'cliente' };
    otherClient = { id: clients[1].id.toString(), role: 'cliente' };
    technician = { id: employee.userId.toString(), role: 'empleado' };
    const [request] = await db
      .insert(service_requests)
      .values({
        client_id: clients[0].id,
        category_id: category.id,
        branch_id: employee.branchId,
        employee_id: employee.id,
        description: 'Prueba de ajustes de precio',
        status: 'llegado',
        agreed_price: '300.00',
        accepted_at: new Date(),
        arrived_at: new Date(),
      })
      .returning({ id: service_requests.UniqueID });
    requestId = request.id;
    created.push(request.id);
    ready = true;
  });

  after(async () => {
    if (created.length) {
      await db.delete(price_adjustment).where(inArray(price_adjustment.request_id, created));
      await db
        .delete(service_request_events)
        .where(inArray(service_request_events.request_id, created));
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

  it('recorre propuesta, rechazo, aprobación y cierre con el total', async (t) => {
    if (!ready) {
      t.skip('La base local no tiene dos clientes, una categoría y un técnico activo.');
      return;
    }

    // Solo el técnico asignado propone; el cliente no.
    await assert.rejects(
      proposePriceAdjustment(requestId, client, { amount: 50, reason: 'tiempo_adicional' }),
      { statusCode: 403 },
    );

    const first = await proposePriceAdjustment(requestId, technician, {
      amount: '150.50',
      reason: 'materiales_extra',
      description: 'Codo y cinta',
      client_uuid: 'ajuste-1',
    });
    assert.equal(first.created, true);
    assert.equal(first.adjustment.status, 'pendiente');

    // El reintento con la misma llave regresa el mismo ajuste.
    const retry = await proposePriceAdjustment(requestId, technician, {
      amount: '150.50',
      reason: 'materiales_extra',
      client_uuid: 'ajuste-1',
    });
    assert.equal(retry.created, false);
    assert.equal(retry.adjustment.id, first.adjustment.id);

    // Uno a la vez: el cliente debe responder antes de otro.
    await assert.rejects(
      proposePriceAdjustment(requestId, technician, { amount: 20, reason: 'tiempo_adicional' }),
      { code: 'PRICE_ADJUSTMENT_PENDING' },
    );

    // No se puede finalizar con un ajuste sin respuesta.
    await assert.rejects(
      advanceServiceRequestStatus(requestId, technician, {
        status: 'completada',
        latitude: 25.6,
        longitude: -103.4,
      }),
      { code: 'PRICE_ADJUSTMENT_PENDING' },
    );

    const adjustmentId = BigInt(first.adjustment.id);
    // Solo responde el cliente de la solicitud; para los demás no existe.
    await assert.rejects(respondPriceAdjustment(requestId, adjustmentId, otherClient, 'aprobado'), {
      statusCode: 404,
    });
    await assert.rejects(respondPriceAdjustment(requestId, adjustmentId, technician, 'aprobado'), {
      statusCode: 404,
    });

    const approved = await respondPriceAdjustment(requestId, adjustmentId, client, 'aprobado');
    assert.equal(approved.adjustment.status, 'aprobado');
    assert.equal(approved.total_amount, '450.50');
    await assert.rejects(respondPriceAdjustment(requestId, adjustmentId, client, 'rechazado'), {
      code: 'PRICE_ADJUSTMENT_ALREADY_RESPONDED',
    });

    // Un segundo ajuste rechazado no suma.
    const second = await proposePriceAdjustment(requestId, technician, {
      amount: 80,
      reason: 'otro',
      description: 'Revisión del boiler',
    });
    await respondPriceAdjustment(requestId, BigInt(second.adjustment.id), client, 'rechazado');

    const summary = await listPriceAdjustments(requestId, client);
    assert.equal(summary.adjustments.length, 2);
    assert.equal(summary.approved_total, '150.50');
    assert.equal(summary.total_amount, '450.50');

    const done = await advanceServiceRequestStatus(requestId, technician, {
      status: 'completada',
      latitude: 25.6,
      longitude: -103.4,
    });
    assert.equal(done.status, 'completada');
    assert.equal(done.total_amount, '450.50');

    // Ya finalizada no se proponen más ajustes.
    await assert.rejects(
      proposePriceAdjustment(requestId, technician, { amount: 10, reason: 'tiempo_adicional' }),
      { code: 'INVALID_REQUEST_STATUS' },
    );
  });
});
