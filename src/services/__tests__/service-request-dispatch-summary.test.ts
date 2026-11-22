import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDatabase } from '../../config/database.ts';
import {
  categories,
  employees,
  request_dispatches,
  roles,
  service_requests,
  users,
} from '../../database/schema/tables.ts';
import { serializeServiceRequestForResponse } from '../service-request-status.service.ts';

describe('API-30: el cliente ve si su solicitud fue rechazada', () => {
  const created: bigint[] = [];

  after(async () => {
    if (created.length) {
      await db.delete(request_dispatches).where(inArray(request_dispatches.request_id, created));
      await db.delete(service_requests).where(inArray(service_requests.UniqueID, created));
    }
    await closeDatabase();
  });

  it('cuenta a cuántos técnicos se avisó y cuántos rechazaron', async (t) => {
    const [client] = await db
      .select({ id: users.UniqueID })
      .from(users)
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(eq(roles.name, 'cliente'))
      .limit(1);
    const [category] = await db.select({ id: categories.UniqueID }).from(categories).limit(1);
    const staff = await db.select({ id: employees.UniqueID }).from(employees).limit(2);
    if (!client || !category || staff.length < 2) {
      t.skip('La base local no tiene cliente, categoría y dos técnicos.');
      return;
    }

    const [request] = await db
      .insert(service_requests)
      .values({
        client_id: client.id,
        category_id: category.id,
        is_emergency: true,
        description: 'Prueba de resumen de avisos',
        status: 'pendiente',
        expires_at: new Date(Date.now() + 5 * 60_000),
      })
      .returning({ id: service_requests.UniqueID });
    created.push(request.id);

    const before = await serializeServiceRequestForResponse(request.id);
    assert.deepEqual(before.dispatches, { sent: 0, rejected: 0 });

    const now = new Date();
    await db.insert(request_dispatches).values([
      { request_id: request.id, employee_id: staff[0].id, notified_at: now },
      {
        request_id: request.id,
        employee_id: staff[1].id,
        notified_at: now,
        responded_at: now,
        response: 'rechazo',
      },
    ]);

    const after = await serializeServiceRequestForResponse(request.id);
    assert.deepEqual(after.dispatches, { sent: 2, rejected: 1 });
    // Rechazar no cambia el estado: sigue pendiente para los demás técnicos.
    assert.equal(after.status, 'pendiente');
  });
});
