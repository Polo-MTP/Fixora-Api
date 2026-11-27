import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  address_user,
  addresses,
  branches,
  business,
  categories,
  employees,
  personal_data,
  price_adjustment,
  reports,
  reviews,
  service_payments,
  service_requests,
} from '../database/schema/tables.ts';
import { ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import {
  ACTIVE_DB_STATUSES,
  canChat,
  canTrack,
  dbStatusesFor,
  paymentStatus,
  parseHistoryQuery,
  pickActiveService,
  publicStatus,
  servicePhase,
  visibleCost,
} from '../utils/client-history.ts';
import { parseReportId } from '../utils/report-validation.ts';
import { computeTotalAmount, countsTowardTotal } from './price-adjustment.rules.ts';
import { serializePayment, summarizePayments } from './payment.rules.ts';
import { storageService } from './storage.service.ts';

interface Actor {
  id: string;
  role: string;
}

type RequestRow = typeof service_requests.$inferSelect;
type AdjustmentRow = typeof price_adjustment.$inferSelect;
type PaymentRow = typeof service_payments.$inferSelect;

const PHOTO_URL_MINUTES = 60;

function assertClient(actor: Actor): bigint {
  if (actor.role.trim().toLowerCase() !== 'cliente') {
    throw new ForbiddenError(
      'Solo los clientes tienen historial de servicios.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
  return BigInt(actor.id);
}

function signedUrl(fileKey: string | null): string | null {
  if (!fileKey) return null;
  try {
    return storageService.generateSignedUrl({
      file_key: fileKey,
      expires_in_minutes: PHOTO_URL_MINUTES,
    }).signed_url;
  } catch {
    return null;
  }
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(key(row)) ?? [];
    list.push(row);
    groups.set(key(row), list);
  }
  return groups;
}

/** Cifras de precio y pago de una solicitud, con las mismas reglas que el detalle de la solicitud. */
function figures(request: RequestRow, adjustments: AdjustmentRow[], payments: PaymentRow[]) {
  const approved = adjustments.filter((row) => countsTowardTotal(row.status));
  const estimate =
    request.agreed_price === null
      ? null
      : computeTotalAmount(
          request.agreed_price,
          approved.map((row) => row.amount),
        );
  const total = request.total_amount ?? estimate;
  const summary = summarizePayments(total ?? '0.00', payments, request.status === 'completada');
  return {
    estimate,
    total,
    approvedAmount: computeTotalAmount(
      null,
      approved.map((row) => row.amount),
    ),
    summary,
  };
}

/** Datos del técnico: lo que se guardó al aceptar y, en solicitudes antiguas, el nombre actual. */
async function resolveTechnician(request: RequestRow) {
  if (!request.employee_id) return null;

  let name = request.technician_name;
  if (!name) {
    const [row] = await db
      .select({ name: personal_data.name, lastname: personal_data.lastname_p })
      .from(employees)
      .innerJoin(personal_data, eq(personal_data.user_id, employees.user_id))
      .where(eq(employees.UniqueID, request.employee_id))
      .limit(1);
    name = row ? [row.name, row.lastname].filter(Boolean).join(' ').trim() || null : null;
  }

  const hasVehicle = Boolean(
    request.vehicle_plate || request.vehicle_brand || request.vehicle_model,
  );
  return {
    employee_id: request.employee_id.toString(),
    name,
    photo_url: signedUrl(request.technician_photo_key),
    vehicle: hasVehicle
      ? {
          plate: request.vehicle_plate,
          brand: request.vehicle_brand,
          model: request.vehicle_model,
          color: request.vehicle_color,
        }
      : null,
  };
}

const headSelect = {
  request: service_requests,
  categoryName: categories.name,
  branchName: branches.name,
  branchPhone: branches.phone,
  businessName: business.name,
};

function providerOf(
  request: RequestRow,
  head: { branchName: string | null; branchPhone: string | null; businessName: string | null },
) {
  return request.branch_id
    ? {
        branch_id: request.branch_id.toString(),
        name: head.branchName,
        business_name: head.businessName,
        phone: head.branchPhone,
      }
    : null;
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

/** GET /api/me/services — historial del cliente: fecha, proveedor, costo y estado, con filtro por estado. */
export async function listClientServices(actor: Actor, rawQuery: unknown) {
  const clientId = assertClient(actor);
  const query = parseHistoryQuery((rawQuery ?? {}) as Record<string, unknown>);

  const where = and(
    eq(service_requests.client_id, clientId),
    query.status
      ? inArray(service_requests.status, dbStatusesFor(query.status) as Array<RequestRow['status']>)
      : undefined,
  );

  const [[countRow], rows] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(service_requests)
      .where(where),
    db
      .select(headSelect)
      .from(service_requests)
      .innerJoin(categories, eq(service_requests.category_id, categories.UniqueID))
      .leftJoin(branches, eq(service_requests.branch_id, branches.UniqueID))
      .leftJoin(business, eq(branches.business_id, business.UniqueID))
      .where(where)
      .orderBy(desc(service_requests.created_at), desc(service_requests.UniqueID))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
  ]);

  const ids = rows.map((row) => row.request.UniqueID);
  const [adjustmentRows, paymentRows, reviewRows, reportRows] = ids.length
    ? await Promise.all([
        db.select().from(price_adjustment).where(inArray(price_adjustment.request_id, ids)),
        db.select().from(service_payments).where(inArray(service_payments.request_id, ids)),
        db
          .select({ requestId: reviews.request_id })
          .from(reviews)
          .where(
            and(
              inArray(reviews.request_id, ids),
              eq(reviews.direction, 'cliente_a_proveedor'),
              eq(reviews.author_id, clientId),
            ),
          ),
        db
          .select({ requestId: reports.request_id })
          .from(reports)
          .where(and(inArray(reports.request_id, ids), eq(reports.reporter_id, clientId))),
      ])
    : [[], [], [], []];

  const adjustmentsById = groupBy(adjustmentRows, (row) => row.request_id.toString());
  const paymentsById = groupBy(paymentRows, (row) => row.request_id.toString());
  const reviewed = new Set(reviewRows.map((row) => row.requestId.toString()));
  const reported = new Set(
    reportRows.flatMap((row) => (row.requestId === null ? [] : [row.requestId.toString()])),
  );

  const total = Number(countRow?.total ?? 0);
  return {
    items: rows.map((row) => {
      const request = row.request;
      const key = request.UniqueID.toString();
      const money = figures(request, adjustmentsById.get(key) ?? [], paymentsById.get(key) ?? []);
      const hasReview = reviewed.has(key);
      return {
        id: key,
        status: publicStatus(request.status),
        phase: servicePhase(request.status),
        is_emergency: request.is_emergency,
        created_at: request.created_at.toISOString(),
        scheduled_at: iso(request.scheduled_at),
        completed_at: iso(request.completed_at),
        category: { id: request.category_id.toString(), name: row.categoryName },
        provider: providerOf(request, row),
        technician_name: request.technician_name,
        cost: visibleCost(request.status, request.total_amount, money.estimate),
        payment_status: paymentStatus(request.status, {
          total: money.total,
          paid: money.summary.paid,
          pending_confirmation: money.summary.pending_confirmation,
        }),
        has_review: hasReview,
        can_review: request.status === 'completada' && !hasReview,
        has_report: reported.has(key),
      };
    }),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.ceil(total / query.limit),
    },
  };
}

// ---------------------------------------------------------------------------
// Detalle con desglose
// ---------------------------------------------------------------------------

/**
 * GET /api/me/services/:id — detalle de un servicio del cliente: categoría, técnico, dirección,
 * fechas, precio base, ajustes, total, pago, reseña y reportes.
 */
export async function getClientService(actor: Actor, rawId: unknown) {
  const clientId = assertClient(actor);
  const requestId = parseReportId(rawId, 'id');

  const [head] = await db
    .select({
      ...headSelect,
      address: addresses,
      addressAlias: address_user.alias,
    })
    .from(service_requests)
    .innerJoin(categories, eq(service_requests.category_id, categories.UniqueID))
    .leftJoin(branches, eq(service_requests.branch_id, branches.UniqueID))
    .leftJoin(business, eq(branches.business_id, business.UniqueID))
    .leftJoin(addresses, eq(service_requests.address_id, addresses.UniqueID))
    .leftJoin(
      address_user,
      and(eq(address_user.address_id, addresses.UniqueID), eq(address_user.user_id, clientId)),
    )
    .where(and(eq(service_requests.UniqueID, requestId), eq(service_requests.client_id, clientId)))
    .limit(1);
  // Una solicitud ajena responde igual que una que no existe.
  if (!head) throw new NotFoundError('El servicio no existe.');
  const request = head.request;

  const [adjustments, payments, [review], reportRows, technician] = await Promise.all([
    db
      .select()
      .from(price_adjustment)
      .where(eq(price_adjustment.request_id, requestId))
      .orderBy(asc(price_adjustment.created_at), asc(price_adjustment.UniqueID)),
    db
      .select()
      .from(service_payments)
      .where(eq(service_payments.request_id, requestId))
      .orderBy(asc(service_payments.created_at), asc(service_payments.UniqueID)),
    db
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.request_id, requestId),
          eq(reviews.direction, 'cliente_a_proveedor'),
          eq(reviews.author_id, clientId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(reports)
      .where(and(eq(reports.request_id, requestId), eq(reports.reporter_id, clientId)))
      .orderBy(asc(reports.UniqueID)),
    resolveTechnician(request),
  ]);

  const money = figures(request, adjustments, payments);
  const address = head.address;

  return {
    id: request.UniqueID.toString(),
    status: publicStatus(request.status),
    phase: servicePhase(request.status),
    is_emergency: request.is_emergency,
    description: request.description,
    category: { id: request.category_id.toString(), name: head.categoryName },
    provider: providerOf(request, head),
    technician,
    address: address
      ? {
          alias: head.addressAlias,
          street: address.street,
          num_ext: address.num_ext,
          num_int: address.num_int,
          colony: address.colony,
          municipality: address.municipality,
          state: address.state,
          postal_code: address.postal_code,
          reference: address.reference,
          full: [
            `${address.street} ${address.num_ext ?? ''}`.trim(),
            address.colony,
            address.municipality,
            address.state,
          ]
            .filter(Boolean)
            .join(', '),
        }
      : null,
    location:
      request.latitude !== null && request.longitude !== null
        ? { latitude: Number(request.latitude), longitude: Number(request.longitude) }
        : null,
    dates: {
      created_at: request.created_at.toISOString(),
      scheduled_at: iso(request.scheduled_at),
      accepted_at: iso(request.accepted_at),
      arrived_at: iso(request.arrived_at),
      completed_at: iso(request.completed_at),
    },
    canceled: request.canceled_by
      ? { by: request.canceled_by, reason: request.canceled_reason }
      : null,
    price: {
      /** Lo acordado al aceptar el servicio. */
      base_price: request.agreed_price,
      adjustments: adjustments.map((row) => ({
        id: row.UniqueID.toString(),
        amount: row.amount,
        reason: row.reason,
        description: row.description,
        status: row.status,
        counts_toward_total: countsTowardTotal(row.status),
        created_at: row.created_at.toISOString(),
        responded_at: iso(row.responded_at),
        paid_at: iso(row.paid_at),
      })),
      /** Suma de los ajustes aprobados o pagados. */
      adjustments_total: money.approvedAmount,
      /** Precio acordado más ajustes; en una solicitud finalizada es el total que se fijó al terminar. */
      total: visibleCost(request.status, request.total_amount, money.estimate),
    },
    payment: {
      status: paymentStatus(request.status, {
        total: money.total,
        paid: money.summary.paid,
        pending_confirmation: money.summary.pending_confirmation,
      }),
      ...money.summary,
      payments: payments.map((row) => {
        const payment = serializePayment(row);
        return {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          method: payment.method,
          reference: payment.reference,
          status: payment.status,
          rejection_reason: payment.rejection_reason,
          created_at: iso(payment.created_at),
          responded_at: iso(payment.responded_at),
          paid_at: iso(payment.paid_at),
        };
      }),
    },
    review: {
      mine: review
        ? {
            id: review.UniqueID.toString(),
            rating: review.rating,
            comment: review.comment,
            created_at: review.created_at.toISOString(),
          }
        : null,
      can_review: request.status === 'completada' && !review,
    },
    reports: reportRows.map((report) => ({
      id: report.UniqueID.toString(),
      folio: report.folio,
      type: report.type,
      category: report.category,
      status: report.status,
      created_at: report.created_at.toISOString(),
      resolved_at: iso(report.resolved_at),
    })),
    can_track: canTrack(request.status),
    can_chat: canChat(request.status, request.employee_id !== null),
  };
}

// ---------------------------------------------------------------------------
// Servicio en curso (banner de la pantalla principal)
// ---------------------------------------------------------------------------

/**
 * GET /api/me/services/active — el servicio en curso del cliente para el banner de la pantalla
 * principal. Si hay más de uno, devuelve el más avanzado y `active_count` indica cuántos hay.
 * Cuenta como en curso lo que está buscando técnico, asignado, en camino o con el técnico en el lugar.
 */
export async function getActiveClientService(actor: Actor) {
  const clientId = assertClient(actor);

  const rows = await db
    .select(headSelect)
    .from(service_requests)
    .innerJoin(categories, eq(service_requests.category_id, categories.UniqueID))
    .leftJoin(branches, eq(service_requests.branch_id, branches.UniqueID))
    .leftJoin(business, eq(branches.business_id, business.UniqueID))
    .where(
      and(
        eq(service_requests.client_id, clientId),
        inArray(service_requests.status, [...ACTIVE_DB_STATUSES] as Array<RequestRow['status']>),
      ),
    )
    .orderBy(desc(service_requests.created_at))
    .limit(20);

  const chosen = pickActiveService(
    rows.map((row) => ({ ...row, status: row.request.status, created_at: row.request.created_at })),
  );
  if (!chosen) return { active: null, active_count: 0 };

  const request = chosen.request;
  const [adjustments, technician] = await Promise.all([
    db.select().from(price_adjustment).where(eq(price_adjustment.request_id, request.UniqueID)),
    resolveTechnician(request),
  ]);
  const money = figures(request, adjustments, []);

  let address: string | null = null;
  if (request.address_id) {
    const [row] = await db
      .select()
      .from(addresses)
      .where(eq(addresses.UniqueID, request.address_id))
      .limit(1);
    if (row) {
      address = [`${row.street} ${row.num_ext ?? ''}`.trim(), row.colony]
        .filter(Boolean)
        .join(', ');
    }
  }

  return {
    active: {
      id: request.UniqueID.toString(),
      status: publicStatus(request.status),
      phase: servicePhase(request.status),
      is_emergency: request.is_emergency,
      category: { id: request.category_id.toString(), name: chosen.categoryName },
      provider: providerOf(request, chosen),
      technician,
      address,
      estimated_total: money.estimate,
      created_at: request.created_at.toISOString(),
      expires_at: iso(request.expires_at),
      scheduled_at: iso(request.scheduled_at),
      accepted_at: iso(request.accepted_at),
      arrived_at: iso(request.arrived_at),
      can_track: canTrack(request.status),
      can_chat: canChat(request.status, request.employee_id !== null),
    },
    active_count: rows.length,
  };
}
