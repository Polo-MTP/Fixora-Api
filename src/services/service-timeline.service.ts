import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  addresses,
  categories,
  conversations,
  employees,
  message_attachments,
  price_adjustment,
  report_attachments,
  reports,
  request_attachments,
  request_dispatches,
  request_messages,
  service_payments,
  service_request_events,
  service_requests,
} from '../database/schema/tables.ts';
import { NotFoundError } from '../errors/app-error.ts';
import { parseReportId } from '../utils/report-validation.ts';
import {
  TIMELINE_TYPES,
  computeServiceDurations,
  distanceMeters,
  mergeTimeline,
  parseTimelineQuery,
  toGeoPoint,
  type GeoPoint,
  type TimelineEntry,
  type TimelineType,
} from '../utils/support-validation.ts';
import { assertSupportStaff, loadUserDirectory } from './support-inbox.service.ts';
import { storageService } from './storage.service.ts';

interface Actor {
  id: string;
  role: string;
}

/** Tope de mensajes y de despachos que se traen; si hay más, la respuesta lo indica. */
const MAX_CHAT_MESSAGES = 1000;
const MAX_DISPATCHES = 200;
const EVIDENCE_URL_MINUTES = 60;

const STATUS_LABEL: Record<string, string> = {
  pendiente: 'Pendiente',
  aceptada: 'Aceptada',
  agendada: 'Agendada',
  en_curso: 'En curso',
  en_camino: 'En camino',
  llegado: 'Llegó al domicilio',
  completada: 'Completada',
  cancelada: 'Cancelada',
  expirada: 'Expirada',
};

const LOCATION_LABEL: Record<string, string> = {
  aceptada: 'Aceptación',
  en_camino: 'Salida del técnico',
  llegado: 'Llegada del técnico',
  completada: 'Cierre del servicio',
  cancelada: 'Cancelación',
};

const ATTACHMENT_LABEL: Record<string, string> = {
  solicitud: 'Archivo de la solicitud',
  evidencia_cancelacion: 'Evidencia de cancelación',
  cierre_servicio: 'Evidencia de cierre del servicio',
};

const DISPATCH_RESPONSE_LABEL: Record<string, string> = {
  acepto: 'aceptó',
  rechazo: 'rechazó',
  expiro: 'no respondió a tiempo',
  retirado: 'quedó fuera porque otro técnico aceptó',
};

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
const money = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);
const label = (status: string | null) => (status ? (STATUS_LABEL[status] ?? status) : '—');

function signedUrl(fileKey: string): string | null {
  try {
    return storageService.generateSignedUrl({
      file_key: fileKey,
      expires_in_minutes: EVIDENCE_URL_MINUTES,
    }).signed_url;
  } catch {
    return null;
  }
}

/**
 * GET /api/support/service-requests/:id/timeline — historial auditable del servicio, solo para
 * Soporte y Administrador. Reúne en orden cronológico los estados (con tiempos y ubicación), los
 * despachos, la cancelación, el chat, los pagos y ajustes de precio, las evidencias y los reportes.
 *
 * El contenido del chat solo se incluye si el servicio tiene al menos un reporte; sin reporte, se
 * muestra solo cuántos mensajes hubo. Es la misma regla de la lectura de chat para Soporte (API-35).
 */
export async function getServiceTimeline(actor: Actor, rawId: unknown, rawQuery: unknown) {
  assertSupportStaff(actor);
  const requestId = parseReportId(rawId, 'id');
  const { types } = parseTimelineQuery((rawQuery ?? {}) as Record<string, unknown>);

  const [head] = await db
    .select({
      request: service_requests,
      categoryName: categories.name,
      street: addresses.street,
      numExt: addresses.num_ext,
      colony: addresses.colony,
      municipality: addresses.municipality,
      addressLat: addresses.latitude,
      addressLng: addresses.longitude,
    })
    .from(service_requests)
    .innerJoin(categories, eq(service_requests.category_id, categories.UniqueID))
    .leftJoin(addresses, eq(service_requests.address_id, addresses.UniqueID))
    .where(eq(service_requests.UniqueID, requestId))
    .limit(1);
  if (!head) throw new NotFoundError('La solicitud no existe.');
  const request = head.request;

  const [
    events,
    dispatches,
    attachments,
    payments,
    adjustments,
    [conversation],
    reportRows,
    [technician],
  ] = await Promise.all([
    db
      .select()
      .from(service_request_events)
      .where(eq(service_request_events.request_id, requestId))
      .orderBy(asc(service_request_events.UniqueID)),
    db
      .select({ dispatch: request_dispatches, userId: employees.user_id })
      .from(request_dispatches)
      .innerJoin(employees, eq(request_dispatches.employee_id, employees.UniqueID))
      .where(eq(request_dispatches.request_id, requestId))
      .orderBy(asc(request_dispatches.notified_at), asc(request_dispatches.UniqueID))
      .limit(MAX_DISPATCHES),
    db
      .select()
      .from(request_attachments)
      .where(eq(request_attachments.request_id, requestId))
      .orderBy(asc(request_attachments.UniqueID)),
    db
      .select()
      .from(service_payments)
      .where(eq(service_payments.request_id, requestId))
      .orderBy(asc(service_payments.UniqueID)),
    db
      .select()
      .from(price_adjustment)
      .where(eq(price_adjustment.request_id, requestId))
      .orderBy(asc(price_adjustment.UniqueID)),
    db.select().from(conversations).where(eq(conversations.request_id, requestId)).limit(1),
    db
      .select()
      .from(reports)
      .where(eq(reports.request_id, requestId))
      .orderBy(asc(reports.UniqueID)),
    request.employee_id !== null
      ? db
          .select({ userId: employees.user_id })
          .from(employees)
          .where(eq(employees.UniqueID, request.employee_id))
          .limit(1)
      : Promise.resolve([]),
  ]);

  // Chat: siempre el resumen; el contenido solo si hay un reporte (misma regla que API-35).
  const chatReadable = reportRows.length > 0;
  let chatTotal = 0;
  let chatFirst: Date | null = null;
  let chatLast: Date | null = null;
  let messages: Array<typeof request_messages.$inferSelect> = [];
  const messageAttachments = new Map<string, number>();
  if (conversation) {
    const [summary] = await db
      .select({
        total: sql<number>`count(*)::int`,
        first: sql<Date | null>`min(${request_messages.created_at})`,
        last: sql<Date | null>`max(${request_messages.created_at})`,
      })
      .from(request_messages)
      .where(eq(request_messages.conversation_id, conversation.UniqueID));
    chatTotal = Number(summary?.total ?? 0);
    chatFirst = summary?.first ? new Date(summary.first) : null;
    chatLast = summary?.last ? new Date(summary.last) : null;

    if (chatReadable && chatTotal > 0) {
      messages = await db
        .select()
        .from(request_messages)
        .where(eq(request_messages.conversation_id, conversation.UniqueID))
        .orderBy(asc(request_messages.UniqueID))
        .limit(MAX_CHAT_MESSAGES);
      if (messages.length) {
        const counts = await db
          .select({
            messageId: message_attachments.message_id,
            total: sql<number>`count(*)::int`,
          })
          .from(message_attachments)
          .where(
            inArray(
              message_attachments.message_id,
              messages.map((message) => message.UniqueID),
            ),
          )
          .groupBy(message_attachments.message_id);
        for (const row of counts) messageAttachments.set(row.messageId.toString(), row.total);
      }
    }
  }

  const reportEvidence = reportRows.length
    ? await db
        .select({ reportId: report_attachments.report_id, total: sql<number>`count(*)::int` })
        .from(report_attachments)
        .where(
          inArray(
            report_attachments.report_id,
            reportRows.map((row) => row.UniqueID),
          ),
        )
        .groupBy(report_attachments.report_id)
    : [];
  const reportEvidenceById = new Map(
    reportEvidence.map((row) => [row.reportId.toString(), row.total]),
  );

  // Nombres y roles de todas las personas que aparecen en el historial.
  const people: bigint[] = [request.client_id];
  for (const event of events) people.push(event.changed_by);
  for (const row of dispatches) people.push(row.userId);
  for (const payment of payments) {
    if (payment.registered_by) people.push(payment.registered_by);
    if (payment.confirmed_by) people.push(payment.confirmed_by);
  }
  for (const adjustment of adjustments) people.push(adjustment.declared_by);
  for (const message of messages) people.push(message.sender_id);
  for (const report of reportRows) {
    people.push(report.reporter_id);
    if (report.reported_id) people.push(report.reported_id);
  }
  if (technician) people.push(technician.userId);
  const directory = await loadUserDirectory(people);

  const actorOf = (id: bigint | null) =>
    id === null
      ? null
      : {
          id: id.toString(),
          name: directory.get(id.toString())?.name ?? null,
          role: directory.get(id.toString())?.role ?? null,
        };
  const nameOf = (id: bigint | null) => (id === null ? null : actorOf(id)?.name) ?? 'Usuario';

  // -------------------------------------------------------------------------
  // Entradas de la línea de tiempo
  // -------------------------------------------------------------------------
  const entries: TimelineEntry[] = [];
  const add = (
    entry: Omit<TimelineEntry, 'actor' | 'details' | 'location'> & Partial<TimelineEntry>,
  ) => entries.push({ actor: null, details: {}, location: null, ...entry });

  // Estados, con su ubicación cuando el cambio la registró.
  let canceledAt: Date | null = null;
  for (const event of events) {
    if (event.to_status === 'cancelada') canceledAt = event.created_at;
    add({
      at: event.created_at.toISOString(),
      type: 'estado',
      kind: event.from_status ? 'cambio_estado' : 'solicitud_creada',
      title: event.from_status
        ? `${label(event.from_status)} → ${label(event.to_status)}`
        : `Solicitud creada (${label(event.to_status)})`,
      actor: actorOf(event.changed_by),
      details: { from_status: event.from_status, to_status: event.to_status },
      location: toGeoPoint(event.latitude, event.longitude),
    });
  }

  // Cancelación, con quién la hizo y por qué.
  if (request.status === 'cancelada' || request.canceled_by) {
    const cancelEvent = events.find((event) => event.to_status === 'cancelada');
    add({
      at: (canceledAt ?? cancelEvent?.created_at ?? request.created_at).toISOString(),
      type: 'cancelacion',
      kind: 'cancelacion',
      title: `Cancelada por ${request.canceled_by ?? 'sin dato'}`,
      actor: actorOf(cancelEvent?.changed_by ?? null),
      details: { canceled_by: request.canceled_by, reason: request.canceled_reason },
    });
  }

  // Técnicos a los que se les notificó la solicitud y cómo respondieron.
  for (const { dispatch, userId } of dispatches) {
    add({
      at: dispatch.notified_at.toISOString(),
      type: 'despacho',
      kind: 'notificado',
      title: `Se notificó a ${nameOf(userId)}`,
      actor: actorOf(userId),
      details: { employee_id: dispatch.employee_id.toString() },
    });
    if (dispatch.responded_at && dispatch.response) {
      add({
        at: dispatch.responded_at.toISOString(),
        type: 'despacho',
        kind: dispatch.response,
        title: `${nameOf(userId)} ${DISPATCH_RESPONSE_LABEL[dispatch.response] ?? dispatch.response}`,
        actor: actorOf(userId),
        details: { employee_id: dispatch.employee_id.toString(), response: dispatch.response },
      });
    }
  }

  // Pagos: el registro y la respuesta del proveedor.
  for (const payment of payments) {
    add({
      at: payment.created_at.toISOString(),
      type: 'pago',
      kind: 'pago_registrado',
      title: `Pago registrado: $${Number(payment.amount).toFixed(2)} ${payment.currency} (${payment.method})`,
      actor: actorOf(payment.registered_by),
      details: {
        payment_id: payment.UniqueID.toString(),
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.method,
        reference: payment.reference,
        status: payment.status,
      },
    });
    if (payment.responded_at) {
      const confirmed = payment.status === 'completado';
      add({
        at: payment.responded_at.toISOString(),
        type: 'pago',
        kind: confirmed ? 'pago_confirmado' : 'pago_rechazado',
        title: confirmed ? 'Pago confirmado por el proveedor' : 'Pago rechazado por el proveedor',
        actor: actorOf(payment.confirmed_by),
        details: {
          payment_id: payment.UniqueID.toString(),
          status: payment.status,
          rejection_reason: payment.rejection_reason,
        },
      });
    }
  }

  // Ajustes de precio: lo declara el técnico y lo responde el cliente.
  for (const adjustment of adjustments) {
    add({
      at: adjustment.created_at.toISOString(),
      type: 'ajuste_precio',
      kind: 'ajuste_declarado',
      title: `Ajuste de precio declarado: $${Number(adjustment.amount).toFixed(2)} (${adjustment.reason})`,
      actor: actorOf(adjustment.declared_by),
      details: {
        adjustment_id: adjustment.UniqueID.toString(),
        amount: Number(adjustment.amount),
        reason: adjustment.reason,
        description: adjustment.description,
        status: adjustment.status,
      },
    });
    if (adjustment.responded_at) {
      add({
        at: adjustment.responded_at.toISOString(),
        type: 'ajuste_precio',
        kind: 'ajuste_respondido',
        title: `Ajuste de precio ${adjustment.status === 'rechazado' ? 'rechazado' : 'aprobado'} por el cliente`,
        actor: actorOf(request.client_id),
        details: { adjustment_id: adjustment.UniqueID.toString(), status: adjustment.status },
      });
    }
    if (adjustment.paid_at) {
      add({
        at: adjustment.paid_at.toISOString(),
        type: 'ajuste_precio',
        kind: 'ajuste_pagado',
        title: 'Ajuste de precio pagado',
        details: { adjustment_id: adjustment.UniqueID.toString() },
      });
    }
  }

  // Evidencias del servicio (solicitud, cancelación y cierre).
  for (const attachment of attachments) {
    add({
      at: attachment.created_at.toISOString(),
      type: 'evidencia',
      kind: attachment.kind,
      title: ATTACHMENT_LABEL[attachment.kind] ?? 'Archivo',
      details: {
        attachment_id: attachment.UniqueID.toString(),
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        caption: attachment.caption,
        url: signedUrl(attachment.file_key),
      },
    });
  }

  // Chat.
  if (conversation) {
    add({
      at: conversation.created_at.toISOString(),
      type: 'chat',
      kind: 'chat_abierto',
      title: 'Se abrió el chat de la solicitud',
      details: { conversation_id: conversation.UniqueID.toString() },
    });
    for (const message of messages) {
      add({
        at: message.created_at.toISOString(),
        type: 'chat',
        kind: 'mensaje',
        title: `Mensaje de ${nameOf(message.sender_id)}`,
        actor: actorOf(message.sender_id),
        details: {
          message_id: message.UniqueID.toString(),
          text: message.message,
          attachments_count: messageAttachments.get(message.UniqueID.toString()) ?? 0,
          read_at: iso(message.read_at),
        },
      });
    }
  }

  // Reportes, garantías y reclamaciones del servicio.
  for (const report of reportRows) {
    add({
      at: report.created_at.toISOString(),
      type: 'reporte',
      kind: 'reporte_creado',
      title: `${report.folio}: ${report.type} (${report.category}) levantado por ${nameOf(report.reporter_id)}`,
      actor: actorOf(report.reporter_id),
      details: {
        report_id: report.UniqueID.toString(),
        folio: report.folio,
        type: report.type,
        category: report.category,
        priority: report.priority,
        evidence_count: reportEvidenceById.get(report.UniqueID.toString()) ?? 0,
      },
    });
    if (report.resolved_at) {
      add({
        at: report.resolved_at.toISOString(),
        type: 'reporte',
        kind: 'reporte_cerrado',
        title: `${report.folio}: ${report.status}`,
        details: {
          report_id: report.UniqueID.toString(),
          folio: report.folio,
          status: report.status,
          resolution_type: report.resolution_type,
        },
      });
    }
  }

  const counts = Object.fromEntries(TIMELINE_TYPES.map((type) => [type, 0])) as Record<
    TimelineType,
    number
  >;
  for (const entry of entries) counts[entry.type] += 1;

  const timeline = mergeTimeline(entries).filter((entry) => !types || types.has(entry.type));

  // -------------------------------------------------------------------------
  // Ubicación, tiempos y resumen económico
  // -------------------------------------------------------------------------
  const serviceLocation: GeoPoint | null =
    toGeoPoint(head.addressLat, head.addressLng) ?? toGeoPoint(request.latitude, request.longitude);

  const locations = [
    ...(serviceLocation
      ? [
          {
            label: 'Ubicación del servicio',
            source: head.addressLat !== null ? 'direccion' : 'emergencia',
            at: null as string | null,
            ...serviceLocation,
          },
        ]
      : []),
    ...events.flatMap((event) => {
      const point = toGeoPoint(event.latitude, event.longitude);
      return point
        ? [
            {
              label: LOCATION_LABEL[event.to_status] ?? `Cambio a ${label(event.to_status)}`,
              source: 'estado',
              at: event.created_at.toISOString() as string | null,
              ...point,
            },
          ]
        : [];
    }),
  ];

  const lastPoint = (status: string): GeoPoint | null => {
    const event = [...events].reverse().find((item) => item.to_status === status);
    return event ? toGeoPoint(event.latitude, event.longitude) : null;
  };

  const approvedAdjustments = adjustments.filter(
    (a) => a.status === 'aprobado' || a.status === 'pagado',
  );
  const confirmedPayments = payments.filter((p) => p.status === 'completado');

  return {
    request: {
      id: request.UniqueID.toString(),
      status: request.status,
      is_emergency: request.is_emergency,
      category: { id: request.category_id.toString(), name: head.categoryName },
      branch_id: request.branch_id?.toString() ?? null,
      address: head.street
        ? `${head.street} ${head.numExt ?? ''}, ${head.colony}, ${head.municipality}`.replace(
            ' ,',
            ',',
          )
        : null,
      description: request.description,
      client: {
        id: request.client_id.toString(),
        name: request.client_name ?? nameOf(request.client_id),
      },
      technician: request.employee_id
        ? {
            employee_id: request.employee_id.toString(),
            name: request.technician_name ?? (technician ? nameOf(technician.userId) : null),
            vehicle_plate: request.vehicle_plate,
          }
        : null,
      canceled: request.canceled_by
        ? { by: request.canceled_by, reason: request.canceled_reason }
        : null,
      scheduled_at: iso(request.scheduled_at),
      scheduled_end: iso(request.scheduled_end),
      created_at: request.created_at.toISOString(),
      accepted_at: iso(request.accepted_at),
      arrived_at: iso(request.arrived_at),
      completed_at: iso(request.completed_at),
    },
    durations: computeServiceDurations({
      created_at: request.created_at,
      accepted_at: request.accepted_at,
      arrived_at: request.arrived_at,
      completed_at: request.completed_at,
      canceled_at: canceledAt,
    }),
    locations,
    audit: {
      arrival_distance_m: distanceMeters(lastPoint('llegado'), serviceLocation),
      completion_distance_m: distanceMeters(lastPoint('completada'), serviceLocation),
    },
    financial: {
      agreed_price: money(request.agreed_price),
      total_amount: money(request.total_amount),
      adjustments: {
        total: adjustments.length,
        pending: adjustments.filter((a) => a.status === 'pendiente').length,
        approved_amount: approvedAdjustments.reduce((sum, a) => sum + Number(a.amount), 0),
      },
      payments: {
        total: payments.length,
        pending: payments.filter((p) => p.status === 'pendiente').length,
        rejected: payments.filter((p) => p.status === 'fallido').length,
        confirmed_amount: confirmedPayments.reduce((sum, p) => sum + Number(p.amount), 0),
      },
    },
    chat: {
      conversation_id: conversation?.UniqueID.toString() ?? null,
      messages_total: chatTotal,
      first_message_at: iso(chatFirst),
      last_message_at: iso(chatLast),
      content_included: chatReadable && messages.length > 0,
      truncated: chatReadable && chatTotal > messages.length,
      content_hidden_reason: !chatReadable && chatTotal > 0 ? 'sin_reporte' : null,
    },
    counts,
    timeline,
  };
}
