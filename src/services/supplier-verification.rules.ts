import { and, eq } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { branches, business_supplier, supplier_applications } from '../database/schema/tables.ts';
import type { DbExecutor } from './price-adjustment.rules.ts';

/**
 * Insignia de «verificado»: el proveedor dueño de la sucursal tiene su solicitud de alta aprobada
 * (sus documentos ya se revisaron). La usan la ficha pública (API-21) y el detalle de la solicitud
 * para la tarjeta del técnico (API-56).
 */
export async function isBranchVerified(
  branchId: bigint,
  executor: DbExecutor = db,
): Promise<boolean> {
  const [approved] = await executor
    .select({ id: supplier_applications.UniqueID })
    .from(branches)
    .innerJoin(
      business_supplier,
      and(
        eq(business_supplier.business_id, branches.business_id),
        eq(business_supplier.active, true),
      ),
    )
    .innerJoin(
      supplier_applications,
      and(
        eq(supplier_applications.supplier_id, business_supplier.supplier_id),
        eq(supplier_applications.state, 'aprobada'),
      ),
    )
    .where(eq(branches.UniqueID, branchId))
    .limit(1);
  return Boolean(approved);
}
