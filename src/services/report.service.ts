import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  employees,
  personal_data,
  report_attachments,
  reports,
  reports_events,
  roles,
  service_requests,
  users,
} from '../database/schema/tables.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import {
  ReportCommentAddedEvent,
  ReportStatusChangedEvent,
} from '../events/events/domain-events.ts';
import { chatPreview } from '../utils/chat-validation.ts';
import {
  REPORT_MAX_EVIDENCE_TOTAL,
  formatFolio,
  isReportClosed,
  isStaffRole,
  isValidReportTransition,
  parseAssignInput,
  parseChangeStatusInput,
  parseCommentInput,
  parseCreateReportInput,
  parseEvidenceInput,
  parseReportListQuery,
  type CreateReportInput,
  type ReportStatus,
  type ReportType,
} from '../utils/report-validation.ts';
import { resolveSide, type ChatActor } from './chat.service.ts';
import { storageService } from './storage.service.ts';

type ReportRow = typeof reports.$inferSelect;
type RequestRow = typeof service_requests.$inferSelect;
type EventRow = typeof reports_events.$inferSelect;
type AttachmentMime = (typeof report_attachments.$inferSelect)['mime_type'];

const EVIDENCE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'application/pdf',
];
const EVIDENCE_URL_MINUTES = 180;
const LIST_DESCRIPTION_PREVIEW = 140;

const STATUS_LABEL: Record<string, string> = {
  en_revision: 'en revisión',
  resuelto: 'resuelto',
  rechazado: 'rechazado',
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

async function findReport(reportId: bigint): Promise<ReportRow | undefined> {
  const [report] = await db.select().from(reports).where(eq(reports.UniqueID, reportId)).limit(1);
  return report;
}

/** Ve el reporte quien lo levantó y el personal de Soporte; para los demás no existe. */
function assertCanView(report: ReportRow | undefined, actor: ChatActor): ReportRow {
  if (!report) throw new NotFoundError('El reporte no existe.');
  if (!isStaffRole(actor.role) && report.reporter_id !== BigInt(actor.id)) {
    throw new NotFoundError('El reporte no existe.');
  }
  return report;
}

function assertStaff(actor: ChatActor): void {
  if (!isStaffRole(actor.role)) {
    throw new ForbiddenError(
      'No tienes permisos para realizar esta acción.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
}

function signedEvidenceUrl(fileKey: string): string | null {
  try {
    return storageService.generateSignedUrl({
      file_key: fileKey,
      expires_in_minutes: EVIDENCE_URL_MINUTES,
    }).signed_url;
  } catch {
    return null;
  }
}

async function validateEvidence(keys: string[], uploaderId: string) {
  const files: Array<{ file_key: string; mime_type: AttachmentMime; size_bytes: number }> = [];
  for (const key of keys) {
    const normalized = key.replace(/\\/g, '/');
    if (
      !(normalized.startsWith('photos/') || normalized.startsWith('evidences/')) ||
      storageService.getFileOwnerId(key) !== uploaderId
    ) {
      throw new ForbiddenError(
        'Solo puedes adjuntar archivos que hayas subido a tu propia cuenta (categorías photos o evidences).',
        'FILE_NOT_OWNED',
      );
    }
    const file = await storageService.getFileForDownload(key);
    if (!EVIDENCE_MIME_TYPES.includes(file.mimeType)) {
      throw new BadRequestError(
        'La evidencia debe ser una imagen JPEG, PNG o WebP, un video MP4 o un PDF.',
        'INVALID_EVIDENCE_FILE_TYPE',
      );
    }
    files.push({
      file_key: key,
      mime_type: file.mimeType as AttachmentMime,
      size_bytes: file.sizeBytes,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Serialización
// ---------------------------------------------------------------------------

async function loadUserNames(userIds: bigint[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      userId: personal_data.user_id,
      name: personal_data.name,
      lastname: personal_data.lastname_p,
    })
    .from(personal_data)
    .where(inArray(personal_data.user_id, unique));
  return new Map(
    rows.map((row) => [
      row.userId.toString(),
      [row.name, row.lastname].filter(Boolean).join(' ').trim(),
    ]),
  );
}

async function loadStaffUserIds(userIds: bigint[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return new Set();
  const rows = await db
    .select({ userId: users.UniqueID, role: roles.name })
    .from(users)
    .innerJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(inArray(users.UniqueID, unique));
  return new Set(rows.filter((row) => isStaffRole(row.role)).map((row) => row.userId.toString()));
}

async function serializeEvents(events: EventRow[], actor: ChatActor) {
  const staffViewer = isStaffRole(actor.role);
  const authorIds = events.map((event) => event.author_id);
  const [names, staffIds] = await Promise.all([
    loadUserNames(authorIds),
    loadStaffUserIds(authorIds),
  ]);

  return events.map((event) => {
    const authorIsStaff = staffIds.has(event.author_id.toString());
    // Quien reportó ve "Soporte", no el nombre de la persona que lo atiende.
    const authorName =
      authorIsStaff && !staffViewer
        ? 'Soporte'
        : (names.get(event.author_id.toString()) ?? (authorIsStaff ? 'Soporte' : 'Usuario'));
    return {
      id: event.UniqueID.toString(),
      type: event.type,
      author_name: authorName,
      author_is_staff: authorIsStaff,
      body: event.body,
      from_status: event.from_status,
      to_status: event.to_status,
      created_at: event.created_at.toISOString(),
      ...(staffViewer
        ? { author_id: event.author_id.toString(), is_internal: event.is_internal }
        : {}),
    };
  });
}

async function serializeAttachments(reportId: bigint, actor: ChatActor) {
  const staffViewer = isStaffRole(actor.role);
  const rows = await db
    .select()
    .from(report_attachments)
    .where(eq(report_attachments.report_id, reportId))
    .orderBy(asc(report_attachments.UniqueID));
  return rows.map((row) => ({
    id: row.UniqueID.toString(),
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    url: signedEvidenceUrl(row.file_key),
    created_at: row.created_at.toISOString(),
    ...(staffViewer ? { uploaded_by: row.uploaded_by.toString() } : {}),
  }));
}

/** Detalle completo: datos, evidencia y bitácora. Soporte ve además notas internas y usuarios. */
async function serializeReportDetail(report: ReportRow, actor: ChatActor) {
  const staffViewer = isStaffRole(actor.role);

  const [events, evidence, request] = await Promise.all([
    db
      .select()
      .from(reports_events)
      .where(
        and(
          eq(reports_events.report_id, report.UniqueID),
          staffViewer ? undefined : eq(reports_events.is_internal, false),
        ),
      )
      .orderBy(asc(reports_events.UniqueID)),
    serializeAttachments(report.UniqueID, actor),
    report.request_id !== null
      ? db
          .select({
            id: service_requests.UniqueID,
            status: service_requests.status,
            branch_id: service_requests.branch_id,
            completed_at: service_requests.completed_at,
          })
          .from(service_requests)
          .where(eq(service_requests.UniqueID, report.request_id))
          .limit(1)
          .then((rows) => rows[0])
      : Promise.resolve(undefined),
  ]);

  const timeline = await serializeEvents(events, actor);

  return {
    id: report.UniqueID.toString(),
    folio: report.folio,
    type: report.type,
    category: report.category,
    priority: report.priority,
    status: report.status,
    description: report.description,
    request: request
      ? {
          id: request.id.toString(),
          status: request.status,
          branch_id: request.branch_id?.toString() ?? null,
          completed_at: request.completed_at ? request.completed_at.toISOString() : null,
        }
      : null,
    resolution_type: report.resolution_type,
    resolution_note: report.resolution_note,
    evidence,
    events: timeline,
    created_at: report.created_at.toISOString(),
    updated_at: report.updated_at.toISOString(),
    resolved_at: report.resolved_at ? report.resolved_at.toISOString() : null,
    ...(staffViewer
      ? {
          reporter_id: report.reporter_id.toString(),
          reported_id: report.reported_id?.toString() ?? null,
          assigned_to: report.assigned_to?.toString() ?? null,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

/** Quién es el señalado: el técnico que atendió, o el cliente. */
async function resolveReported(
  request: RequestRow,
  side: 'cliente' | 'proveedor',
): Promise<bigint | null> {
  if (side === 'proveedor') return request.client_id;
  if (request.employee_id === null) return null;
  const [employee] = await db
    .select({ userId: employees.user_id })
    .from(employees)
    .where(eq(employees.UniqueID, request.employee_id))
    .limit(1);
  return employee?.userId ?? null;
}

async function findByClientUuid(reporterId: bigint, clientUuid: string) {
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.reporter_id, reporterId), eq(reports.client_uuid, clientUuid)))
    .limit(1);
  return row;
}

async function emitStatusChanged(
  report: ReportRow,
  fromStatus: string | null,
  changedBy: string,
  comment: string | null,
) {
  await eventBus.notify(
    new ReportStatusChangedEvent({
      reportId: report.UniqueID.toString(),
      reporterId: report.reporter_id.toString(),
      fromStatus,
      toStatus: report.status,
      changedBy,
      category: report.category,
      resolutionType: report.resolution_type,
      comment,
      folio: report.folio,
      reportType: report.type,
      alreadyLogged: true,
    }),
  );
}

/**
 * POST /api/reports — reporte, garantía o reclamación ligados a un servicio.
 * Lo levanta quien participa en la solicitud. `created: false` indica que el client_uuid ya existía.
 */
export async function createReport(actor: ChatActor, rawBody: unknown) {
  const input: CreateReportInput = parseCreateReportInput(rawBody);
  const reporterId = BigInt(actor.id);

  if (input.client_uuid !== null) {
    const existing = await findByClientUuid(reporterId, input.client_uuid);
    if (existing) return { report: await serializeReportDetail(existing, actor), created: false };
  }

  const [request] = await db
    .select()
    .from(service_requests)
    .where(eq(service_requests.UniqueID, input.request_id))
    .limit(1);
  if (!request) throw new NotFoundError('La solicitud no existe.');

  const side = await resolveSide(request, actor);
  if (!side) throw new NotFoundError('La solicitud no existe.');

  if (request.employee_id === null) {
    throw new ConflictError(
      'Solo puedes reportar un servicio que ya tiene técnico asignado.',
      'REPORT_NOT_ALLOWED',
    );
  }
  if (input.type === 'garantia' && side !== 'cliente') {
    throw new ConflictError('Las garantías las solicita el cliente.', 'REPORT_NOT_ALLOWED');
  }
  if (input.type !== 'reporte' && request.status !== 'completada') {
    throw new ConflictError(
      'Las garantías y reclamaciones se levantan sobre un servicio finalizado.',
      'REPORT_NOT_ALLOWED',
    );
  }

  const [open] = await db
    .select({ folio: reports.folio })
    .from(reports)
    .where(
      and(
        eq(reports.request_id, request.UniqueID),
        eq(reports.reporter_id, reporterId),
        eq(reports.type, input.type),
        inArray(reports.status, ['pendiente', 'en_revision']),
      ),
    )
    .limit(1);
  if (open) {
    throw new ConflictError(
      `Ya tienes un caso abierto de este tipo para el servicio (${open.folio}).`,
      'REPORT_ALREADY_OPEN',
    );
  }

  const reportedId = await resolveReported(request, side);
  const evidence = await validateEvidence(input.attachment_keys, actor.id);

  let created: ReportRow;
  try {
    created = await db.transaction(async (tx) => {
      // El número del folio sale de una secuencia: no se repite aunque dos reportes lleguen a la vez.
      const sequenceRows = (await tx.execute(
        sql`SELECT nextval('reports_folio_seq')::text AS n`,
      )) as unknown as Array<{ n: string }>;
      const folio = formatFolio(
        input.type as ReportType,
        new Date().getFullYear(),
        sequenceRows[0]!.n,
      );

      const [row] = await tx
        .insert(reports)
        .values({
          reporter_id: reporterId,
          request_id: request.UniqueID,
          type: input.type,
          folio,
          reported_id: reportedId,
          client_uuid: input.client_uuid,
          category: input.category,
          description: input.description,
        })
        .returning();

      if (evidence.length) {
        await tx.insert(report_attachments).values(
          evidence.map((file) => ({
            report_id: row!.UniqueID,
            uploaded_by: reporterId,
            file_key: file.file_key,
            mime_type: file.mime_type,
            size_bytes: file.size_bytes,
          })),
        );
      }

      // Primera línea de la bitácora, en la misma transacción que el reporte.
      await tx.insert(reports_events).values({
        report_id: row!.UniqueID,
        author_id: reporterId,
        type: 'cambio_estado',
        body: 'Reporte creado.',
        from_status: null,
        to_status: 'pendiente',
      });
      return row!;
    });
  } catch (error) {
    // Dos envíos a la vez con el mismo client_uuid: gana el primero y el otro recibe su resultado.
    if (isUniqueViolation(error) && input.client_uuid !== null) {
      const raced = await findByClientUuid(reporterId, input.client_uuid);
      if (raced) return { report: await serializeReportDetail(raced, actor), created: false };
    }
    throw error;
  }

  // Acuse de recibo con el folio para quien reportó, y aviso en tiempo real para Soporte.
  await emitStatusChanged(created, null, actor.id, null);

  return { report: await serializeReportDetail(created, actor), created: true };
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** GET /api/reports/:id */
export async function getReport(reportId: bigint, actor: ChatActor) {
  const report = assertCanView(await findReport(reportId), actor);
  return serializeReportDetail(report, actor);
}

/** GET /api/reports — Soporte ve todos con filtros; los demás, solo los que levantaron. */
export async function listReports(actor: ChatActor, rawQuery: unknown) {
  const query = parseReportListQuery((rawQuery ?? {}) as Record<string, unknown>);
  const staff = isStaffRole(actor.role);
  const actorId = BigInt(actor.id);

  const where = and(
    staff ? undefined : eq(reports.reporter_id, actorId),
    query.status ? eq(reports.status, query.status) : undefined,
    query.type ? eq(reports.type, query.type) : undefined,
    query.category ? eq(reports.category, query.category) : undefined,
    query.priority ? eq(reports.priority, query.priority) : undefined,
    query.request_id !== null ? eq(reports.request_id, query.request_id) : undefined,
    staff && query.assigned_to !== null
      ? eq(reports.assigned_to, query.assigned_to === 'me' ? actorId : query.assigned_to)
      : undefined,
    staff && query.q ? like(reports.folio, `${query.q}%`) : undefined,
  );

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reports)
    .where(where);

  const rows = await db
    .select()
    .from(reports)
    .where(where)
    .orderBy(desc(reports.created_at), desc(reports.UniqueID))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const total = Number(countRow?.total ?? 0);
  return {
    items: rows.map((row) => ({
      id: row.UniqueID.toString(),
      folio: row.folio,
      type: row.type,
      category: row.category,
      priority: row.priority,
      status: row.status,
      request_id: row.request_id?.toString() ?? null,
      description:
        row.description.length > LIST_DESCRIPTION_PREVIEW
          ? `${row.description.slice(0, LIST_DESCRIPTION_PREVIEW - 3)}...`
          : row.description,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
      ...(staff
        ? {
            reporter_id: row.reporter_id.toString(),
            reported_id: row.reported_id?.toString() ?? null,
            assigned_to: row.assigned_to?.toString() ?? null,
          }
        : {}),
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.ceil(total / query.limit),
    },
  };
}

// ---------------------------------------------------------------------------
// Bitácora: comentarios y evidencia
// ---------------------------------------------------------------------------

/** POST /api/reports/:id/comments — comentario en la bitácora; Soporte puede dejarlo como nota interna. */
export async function addComment(reportId: bigint, actor: ChatActor, rawBody: unknown) {
  const input = parseCommentInput(rawBody);
  const report = assertCanView(await findReport(reportId), actor);
  const staff = isStaffRole(actor.role);

  if (input.internal && !staff) {
    throw new ForbiddenError('Solo Soporte puede dejar notas internas.', 'INTERNAL_NOTE_FORBIDDEN');
  }
  if (!staff && isReportClosed(report.status)) {
    throw new ConflictError('El reporte ya está cerrado.', 'REPORT_CLOSED');
  }

  const event = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(reports_events)
      .values({
        report_id: report.UniqueID,
        author_id: BigInt(actor.id),
        type: 'comentario',
        body: input.body,
        is_internal: input.internal,
      })
      .returning();
    await tx
      .update(reports)
      .set({ updated_at: new Date() })
      .where(eq(reports.UniqueID, report.UniqueID));
    return row!;
  });

  await eventBus.notify(
    new ReportCommentAddedEvent({
      reportId: report.UniqueID.toString(),
      folio: report.folio,
      reporterId: report.reporter_id.toString(),
      authorId: actor.id,
      authorIsStaff: staff,
      internal: input.internal,
      preview: chatPreview(input.body, 0),
    }),
  );

  const [serialized] = await serializeEvents([event], actor);
  return serialized!;
}

/** POST /api/reports/:id/evidence — agrega más archivos a un reporte ya levantado. */
export async function addEvidence(reportId: bigint, actor: ChatActor, rawBody: unknown) {
  const input = parseEvidenceInput(rawBody);
  const report = assertCanView(await findReport(reportId), actor);
  const staff = isStaffRole(actor.role);

  if (!staff && isReportClosed(report.status)) {
    throw new ConflictError('El reporte ya está cerrado.', 'REPORT_CLOSED');
  }

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(report_attachments)
    .where(eq(report_attachments.report_id, report.UniqueID));
  if (Number(countRow?.total ?? 0) + input.attachment_keys.length > REPORT_MAX_EVIDENCE_TOTAL) {
    throw new ConflictError(
      `Un reporte admite hasta ${REPORT_MAX_EVIDENCE_TOTAL} archivos de evidencia.`,
      'REPORT_EVIDENCE_LIMIT',
    );
  }

  const files = await validateEvidence(input.attachment_keys, actor.id);
  const uploaderId = BigInt(actor.id);
  const note = `Agregó ${files.length} ${files.length === 1 ? 'archivo' : 'archivos'} de evidencia.`;

  await db.transaction(async (tx) => {
    await tx.insert(report_attachments).values(
      files.map((file) => ({
        report_id: report.UniqueID,
        uploaded_by: uploaderId,
        file_key: file.file_key,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
      })),
    );
    await tx.insert(reports_events).values({
      report_id: report.UniqueID,
      author_id: uploaderId,
      type: 'comentario',
      body: note,
    });
    await tx
      .update(reports)
      .set({ updated_at: new Date() })
      .where(eq(reports.UniqueID, report.UniqueID));
  });

  await eventBus.notify(
    new ReportCommentAddedEvent({
      reportId: report.UniqueID.toString(),
      folio: report.folio,
      reporterId: report.reporter_id.toString(),
      authorId: actor.id,
      authorIsStaff: staff,
      internal: false,
      preview: note,
    }),
  );

  return { evidence: await serializeAttachments(report.UniqueID, actor) };
}

// ---------------------------------------------------------------------------
// Atención de Soporte: estado y asignación
// ---------------------------------------------------------------------------

/**
 * POST /api/reports/:id/status — solo Soporte y Administrador.
 * pendiente → en_revision | rechazado; en_revision → resuelto | rechazado.
 * Guarda el cambio y su línea de bitácora en una transacción y avisa a quien reportó.
 */
export async function changeReportStatus(reportId: bigint, actor: ChatActor, rawBody: unknown) {
  assertStaff(actor);
  const input = parseChangeStatusInput(rawBody);
  const report = await findReport(reportId);
  if (!report) throw new NotFoundError('El reporte no existe.');

  const from = report.status as ReportStatus;
  if (!isValidReportTransition(from, input.status)) {
    throw new ConflictError(
      `No se puede pasar un reporte de "${from}" a "${input.status}".`,
      'INVALID_REPORT_TRANSITION',
    );
  }

  const actorId = BigInt(actor.id);
  const now = new Date();
  const closing = isReportClosed(input.status);
  const takesOwnership = input.status === 'en_revision' && report.assigned_to === null;

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(reports)
      .set({
        status: input.status,
        updated_at: now,
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.resolution_type ? { resolution_type: input.resolution_type } : {}),
        ...(closing ? { resolved_at: now, resolution_note: input.comment } : {}),
        ...(takesOwnership ? { assigned_to: actorId } : {}),
      })
      // Si otra persona cambió el estado en el mismo momento, este cambio no se aplica.
      .where(and(eq(reports.UniqueID, reportId), eq(reports.status, report.status)))
      .returning();

    if (!row) {
      throw new ConflictError(
        'El reporte cambió de estado mientras lo atendías. Vuelve a consultarlo.',
        'REPORT_STATE_CONFLICT',
      );
    }

    if (takesOwnership) {
      await tx.insert(reports_events).values({
        report_id: reportId,
        author_id: actorId,
        type: 'asignacion',
        body: 'Reporte tomado por Soporte.',
        is_internal: true,
      });
    }

    await tx.insert(reports_events).values({
      report_id: reportId,
      author_id: actorId,
      type: closing ? 'resolucion' : 'cambio_estado',
      body: input.comment ?? `El reporte pasó a ${STATUS_LABEL[input.status] ?? input.status}.`,
      from_status: from,
      to_status: input.status,
    });
    return row;
  });

  await emitStatusChanged(updated, from, actor.id, input.comment);
  return serializeReportDetail(updated, actor);
}

/** POST /api/reports/:id/assign — Soporte toma el reporte; un Administrador puede asignarlo a otra persona. */
export async function assignReport(reportId: bigint, actor: ChatActor, rawBody: unknown) {
  assertStaff(actor);
  const { assigned_to } = parseAssignInput(rawBody);
  const report = await findReport(reportId);
  if (!report) throw new NotFoundError('El reporte no existe.');
  if (isReportClosed(report.status)) {
    throw new ConflictError('El reporte ya está cerrado.', 'REPORT_CLOSED');
  }

  const actorId = BigInt(actor.id);
  const targetId = assigned_to ?? actorId;
  if (targetId !== actorId && actor.role.trim().toLowerCase() !== 'administrador') {
    throw new ForbiddenError(
      'Solo un Administrador puede asignar reportes a otra persona.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }

  const [target] = await db
    .select({ id: users.UniqueID, role: roles.name, state: users.state })
    .from(users)
    .innerJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(eq(users.UniqueID, targetId))
    .limit(1);
  if (!target || !isStaffRole(target.role) || target.state !== 'activo') {
    throw new BadRequestError(
      'assigned_to debe ser un usuario activo de Soporte o Administrador.',
      'INVALID_ASSIGNEE',
    );
  }

  if (report.assigned_to === targetId) return serializeReportDetail(report, actor);

  const names = await loadUserNames([targetId]);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(reports)
      .set({ assigned_to: targetId, updated_at: new Date() })
      .where(eq(reports.UniqueID, reportId))
      .returning();
    await tx.insert(reports_events).values({
      report_id: reportId,
      author_id: actorId,
      type: 'asignacion',
      body:
        targetId === actorId
          ? 'Reporte tomado por Soporte.'
          : `Reporte asignado a ${names.get(targetId.toString()) ?? 'otra persona de Soporte'}.`,
      is_internal: true,
    });
    return row!;
  });

  return serializeReportDetail(updated, actor);
}
