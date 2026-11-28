import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  ownerIsManager,
  ownerManagerEmployee,
  validateManagerIsOwner,
} from '../../utils/supplier-application-validation.ts';

const technician = {
  email: 'tecnico@test.com',
  password: 'Test12345',
  name: 'Luis',
  lastname_p: 'Pérez',
  role: 'empleado' as const,
};
const otherManager = { ...technician, email: 'gerente@test.com', role: 'gerente' as const };

describe('manager_is_owner: "Ser gerente de este local" en la solicitud de proveedor', () => {
  describe('validateManagerIsOwner', () => {
    it('acepta true, false y la ausencia del campo', () => {
      assert.doesNotThrow(() =>
        validateManagerIsOwner([
          { manager_is_owner: true },
          { manager_is_owner: false },
          {},
          { manager_is_owner: undefined },
        ]),
      );
    });

    it('rechaza valores que no son booleanos e indica qué local falla', () => {
      for (const value of ['true', 1, 'si', {}, []]) {
        assert.throws(
          () =>
            validateManagerIsOwner([
              { manager_is_owner: true },
              { manager_is_owner: value as unknown as boolean },
            ]),
          (error: unknown) =>
            error instanceof BadRequestError && /local #2.*verdadero o falso/.test(error.message),
          String(value),
        );
      }
    });

    it('no permite otro gerente en el mismo local si el proveedor es el gerente', () => {
      assert.throws(
        () => validateManagerIsOwner([{ manager_is_owner: true, employees: [otherManager] }]),
        (error: unknown) =>
          error instanceof BadRequestError && /local #1 ya tiene un gerente/.test(error.message),
      );
    });

    it('permite técnicos junto al proveedor gerente, y otro gerente si el proveedor no lo es', () => {
      assert.doesNotThrow(() =>
        validateManagerIsOwner([{ manager_is_owner: true, employees: [technician] }]),
      );
      assert.doesNotThrow(() =>
        validateManagerIsOwner([{ manager_is_owner: false, employees: [otherManager] }]),
      );
      assert.doesNotThrow(() => validateManagerIsOwner([{ employees: [otherManager] }]));
    });

    it('cada local se evalúa por separado', () => {
      assert.doesNotThrow(() =>
        validateManagerIsOwner([
          { manager_is_owner: true, employees: [technician] },
          { manager_is_owner: false, employees: [otherManager] },
        ]),
      );
    });
  });

  describe('ownerIsManager', () => {
    it('solo un true explícito cuenta', () => {
      assert.equal(ownerIsManager({ manager_is_owner: true }), true);
      assert.equal(ownerIsManager({ manager_is_owner: false }), false);
      assert.equal(ownerIsManager({}), false);
    });
  });

  describe('ownerManagerEmployee', () => {
    it('guarda al proveedor como gerente del local con su misma cuenta', () => {
      const row = ownerManagerEmployee('empresa', 7n, 21n);
      assert.equal(row.user_id, 7n);
      assert.equal(row.branch_id, 21n);
      assert.equal(row.is_manager, true);
      assert.equal(row.active, true);
    });

    it('el independiente atiende solicitudes; el de una empresa solo gerencia', () => {
      assert.equal(ownerManagerEmployee('independiente', 7n, 21n).can_attend, true);
      assert.equal(ownerManagerEmployee('empresa', 7n, 21n).can_attend, false);
    });
  });
});
