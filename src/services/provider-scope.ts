import { and, eq } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { branches, business_supplier, employees, suppliers } from '../database/schema/tables.ts';
import { BadRequestError } from '../errors/app-error.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import { checkBranchAccess } from './portfolio.service.ts';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

/**
 * Qué sucursales le tocan a una cuenta del lado del proveedor. Lo comparten las estadísticas
 * (API-44) y los ingresos (API-46).
 */

export function parseBranchId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new BadRequestError('branch_id no es un identificador válido.', 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

/** Sucursales de los negocios de los que la cuenta es dueña. */
export async function ownedBranchIds(userId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ id: branches.UniqueID })
    .from(branches)
    .innerJoin(business_supplier, eq(business_supplier.business_id, branches.business_id))
    .innerJoin(suppliers, eq(suppliers.UniqueID, business_supplier.supplier_id))
    .where(and(eq(suppliers.user_id, userId), eq(business_supplier.active, true)));
  return rows.map((row) => row.id);
}

/** Sucursales donde la cuenta trabaja (como gerente o técnico). */
export async function assignedBranchIds(userId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ branchId: employees.branch_id })
    .from(employees)
    .where(and(eq(employees.user_id, userId), eq(employees.active, true)));
  return [...new Set(rows.map((row) => row.branchId.toString()))].map(BigInt);
}

/**
 * Sucursales que administra la cuenta: con [rawBranchId], esa (si tiene acceso); si no, todas las
 * del dueño o las del gerente. Un técnico no administra sucursales.
 */
export async function managedBranchIds(actor: Actor, rawBranchId: unknown): Promise<bigint[]> {
  if (rawBranchId !== undefined && rawBranchId !== '') {
    const branchId = parseBranchId(rawBranchId);
    await checkBranchAccess(branchId, actor as AuthenticatedUser);
    return [branchId];
  }
  const userId = BigInt(actor.id);
  const branchIds =
    actor.role === 'proveedor'
      ? await ownedBranchIds(userId)
      : actor.role === 'gerente'
        ? await assignedBranchIds(userId)
        : [];
  if (!branchIds.length) {
    throw new BadRequestError(
      'Tu cuenta no administra sucursales: indica branch_id.',
      'BRANCH_SCOPE_REQUIRED',
    );
  }
  return branchIds;
}
