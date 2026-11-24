import { eq, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { branches, reviews, service_requests, users } from '../database/schema/tables.ts';

/**
 * Recalcula rating_avg y reviews_count de un usuario con TODAS sus reseñas publicadas.
 * Se calcula desde las reseñas y no se suma sobre el valor anterior: así el resultado es el mismo
 * aunque se ejecute dos veces, y corrige cualquier descuadre (por ejemplo, al ocultar una reseña).
 */
export async function recalculateUserRating(userId: bigint): Promise<void> {
  const id = userId.toString();
  await db
    .update(users)
    .set({
      rating_avg: sql`COALESCE((
        SELECT ROUND(AVG(${reviews.rating})::numeric, 2)
        FROM ${reviews}
        WHERE ${reviews.reviewee_id} = ${id} AND ${reviews.status} = 'publicada'
      ), 0)`,
      reviews_count: sql`(
        SELECT COUNT(*)::int
        FROM ${reviews}
        WHERE ${reviews.reviewee_id} = ${id} AND ${reviews.status} = 'publicada'
      )`,
    })
    .where(eq(users.UniqueID, userId));
}

/**
 * Recalcula rating_avg y reviews_count de una sucursal con las reseñas de clientes sobre las
 * solicitudes que atendió. Las reseñas del proveedor al cliente no cuentan para la sucursal.
 */
export async function recalculateBranchRating(branchId: bigint): Promise<void> {
  const id = branchId.toString();
  await db
    .update(branches)
    .set({
      rating_avg: sql`COALESCE((
        SELECT ROUND(AVG(${reviews.rating})::numeric, 2)
        FROM ${reviews}
        INNER JOIN ${service_requests} ON ${service_requests.UniqueID} = ${reviews.request_id}
        WHERE ${service_requests.branch_id} = ${id}
          AND ${reviews.direction} = 'cliente_a_proveedor'
          AND ${reviews.status} = 'publicada'
      ), 0)`,
      reviews_count: sql`(
        SELECT COUNT(*)::int
        FROM ${reviews}
        INNER JOIN ${service_requests} ON ${service_requests.UniqueID} = ${reviews.request_id}
        WHERE ${service_requests.branch_id} = ${id}
          AND ${reviews.direction} = 'cliente_a_proveedor'
          AND ${reviews.status} = 'publicada'
      )`,
    })
    .where(eq(branches.UniqueID, branchId));
}
