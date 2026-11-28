import { BadRequestError } from '../errors/app-error.ts';
import type { BranchInput, SupplierType } from '../types/supplier-application.types.ts';

type BranchManagerFields = Pick<BranchInput, 'manager_is_owner' | 'employees'>;

/**
 * Valida manager_is_owner de cada local de la solicitud ("Ser gerente de este local").
 * - Debe ser verdadero o falso.
 * - Si es verdadero, el local no puede traer además otro gerente en `employees`: un local tiene un
 *   solo gerente, y aquí lo es el propio proveedor.
 */
export function validateManagerIsOwner(branches: readonly BranchManagerFields[]): void {
  branches.forEach((branch, index) => {
    const flag: unknown = branch.manager_is_owner;
    if (flag !== undefined && flag !== null && typeof flag !== 'boolean') {
      throw new BadRequestError(
        `El campo manager_is_owner del local #${index + 1} debe ser verdadero o falso.`,
        'VALIDATION_ERROR',
      );
    }
    if (flag === true && branch.employees?.some((employee) => employee.role === 'gerente')) {
      throw new BadRequestError(
        `El local #${index + 1} ya tiene un gerente en employees. Si el proveedor es el gerente de este local, quita al otro gerente.`,
        'VALIDATION_ERROR',
      );
    }
  });
}

/** El proveedor marcó "Ser gerente de este local". Solo cuenta un true explícito. */
export function ownerIsManager(branch: Pick<BranchInput, 'manager_is_owner'>): boolean {
  return branch.manager_is_owner === true;
}

/**
 * Fila de employees que guarda al proveedor como gerente de un local con su misma cuenta.
 * El proveedor independiente atiende solicitudes; el de una empresa gerencia sin atender (puede
 * cambiarse después).
 */
export function ownerManagerEmployee(supplierType: SupplierType, userId: bigint, branchId: bigint) {
  return {
    user_id: userId,
    branch_id: branchId,
    can_attend: supplierType === 'independiente',
    active: true,
    is_manager: true,
  };
}
