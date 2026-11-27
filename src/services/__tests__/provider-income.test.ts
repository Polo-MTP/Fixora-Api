import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase } from '../../config/database.ts';
import { BadRequestError } from '../../errors/app-error.ts';
import { listProviderIncome } from '../provider-income.service.ts';
import { managedBranchIds, parseBranchId } from '../provider-scope.ts';

describe('API-46: ingresos del proveedor', () => {
  it('branch_id debe ser un identificador', () => {
    assert.equal(parseBranchId('21'), 21n);
    for (const bad of ['0', 'abc', '1.5', 21]) {
      assert.throws(() => parseBranchId(bad), BadRequestError, String(bad));
    }
  });

  it('page y limit se validan antes de consultar', async () => {
    const actor = { id: '9', role: 'proveedor' };
    for (const query of [{ page: '0' }, { limit: '101' }, { limit: 'todo' }]) {
      await assert.rejects(
        () => listProviderIncome(actor, query),
        (err: unknown) => err instanceof BadRequestError,
        JSON.stringify(query),
      );
    }
  });

  it('un técnico no administra sucursales: debe indicar branch_id', async () => {
    await assert.rejects(
      () => managedBranchIds({ id: '999999999', role: 'empleado' }, undefined),
      (err: unknown) => (err as BadRequestError).code === 'BRANCH_SCOPE_REQUIRED',
    );
  });

  after(async () => {
    await closeDatabase();
  });
});
