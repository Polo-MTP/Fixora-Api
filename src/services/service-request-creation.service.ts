import { and, asc, eq, gte, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import {
  address_user,
  addresses,
  branches,
  branches_categories,
  branch_schedules,
  categories,
  employees,
  request_attachments,
  schedule_blocks,
  service_request_events,
  service_requests,
} from '../database/schema/tables.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import { ServiceRequestStatusChangedEvent } from '../events/events/domain-events.ts';
import { storageService } from './storage.service.ts';
import { timerService } from './timer.service.ts';
import { getServiceRequest } from './service-request-status.service.ts';

const SLOT_INTERVAL_MINUTES = 30;
const ACTIVE_BOOKING_STATUSES = [
  'aceptada',
  'agendada',
  'en_curso',
  'en_camino',
  'llegado',
] as const;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AddressInput = {
  alias?: string;
  reference?: string;
  street: string;
  num_ext: string;
  num_int?: string;
  colony: string;
  municipality: string;
  state: string;
  postal_code: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  is_main?: boolean;
};

interface CreateRequestInput {
  client_uuid: string;
  branch_id: string;
  category_id: string;
  description: string;
  address_id?: string;
  address?: AddressInput;
  attachment_keys?: string[];
  scheduled_at?: string;
}

function idToBigint(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new BadRequestError(`${field} debe ser un identificador válido.`, 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

function parseCreateInput(value: unknown): CreateRequestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = value as Record<string, unknown>;
  const allowed = [
    'client_uuid',
    'branch_id',
    'category_id',
    'description',
    'address_id',
    'address',
    'attachment_keys',
    'scheduled_at',
  ];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
  }

  if (
    typeof body.client_uuid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.client_uuid,
    )
  ) {
    throw new BadRequestError('client_uuid debe ser un UUID válido.', 'VALIDATION_ERROR');
  }
  idToBigint(body.branch_id, 'branch_id');
  idToBigint(body.category_id, 'category_id');
  if (
    typeof body.description !== 'string' ||
    !body.description.trim() ||
    body.description.trim().length > 2000
  ) {
    throw new BadRequestError(
      'description es obligatorio y no debe exceder 2000 caracteres.',
      'VALIDATION_ERROR',
    );
  }
  const hasAddressId = typeof body.address_id === 'string';
  const hasAddress = body.address !== undefined;
  if (hasAddressId === hasAddress) {
    throw new BadRequestError(
      'Debes enviar address_id o address, pero no ambos.',
      'VALIDATION_ERROR',
    );
  }
  if (hasAddressId) idToBigint(body.address_id, 'address_id');

  let address: AddressInput | undefined;
  if (hasAddress) {
    if (!body.address || typeof body.address !== 'object' || Array.isArray(body.address)) {
      throw new BadRequestError('address debe ser un objeto válido.', 'VALIDATION_ERROR');
    }
    const raw = body.address as Record<string, unknown>;
    const required = ['street', 'num_ext', 'colony', 'municipality', 'state', 'postal_code'];
    const invalid = required.filter(
      (key) => typeof raw[key] !== 'string' || !(raw[key] as string).trim(),
    );
    if (invalid.length)
      throw new BadRequestError(
        `Faltan campos de dirección: ${invalid.join(', ')}.`,
        'VALIDATION_ERROR',
      );
    for (const field of ['latitude', 'longitude'] as const) {
      const coordinate = raw[field];
      if (
        coordinate !== undefined &&
        coordinate !== null &&
        (typeof coordinate !== 'number' ||
          !Number.isFinite(coordinate) ||
          (field === 'latitude'
            ? coordinate < -90 || coordinate > 90
            : coordinate < -180 || coordinate > 180))
      ) {
        throw new BadRequestError(`${field} no tiene un valor válido.`, 'VALIDATION_ERROR');
      }
    }
    if (raw.is_main !== undefined && typeof raw.is_main !== 'boolean') {
      throw new BadRequestError('address.is_main debe ser booleano.', 'VALIDATION_ERROR');
    }
    address = raw as AddressInput;
  }

  let attachmentKeys: string[] = [];
  if (body.attachment_keys !== undefined) {
    if (
      !Array.isArray(body.attachment_keys) ||
      body.attachment_keys.length > 5 ||
      body.attachment_keys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 500)
    ) {
      throw new BadRequestError(
        'attachment_keys debe contener hasta 5 llaves de fotografías válidas.',
        'VALIDATION_ERROR',
      );
    }
    attachmentKeys = [...new Set(body.attachment_keys as string[])];
    if (attachmentKeys.length !== body.attachment_keys.length) {
      throw new BadRequestError('No repitas llaves en attachment_keys.', 'VALIDATION_ERROR');
    }
  }

  let scheduledAt: string | undefined;
  if (body.scheduled_at !== undefined) {
    if (
      typeof body.scheduled_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(body.scheduled_at) ||
      !Number.isFinite(Date.parse(body.scheduled_at))
    ) {
      throw new BadRequestError(
        'scheduled_at debe ser una fecha ISO 8601 válida.',
        'VALIDATION_ERROR',
      );
    }
    scheduledAt = body.scheduled_at;
  }

  return {
    client_uuid: body.client_uuid,
    branch_id: body.branch_id as string,
    category_id: body.category_id as string,
    description: body.description.trim(),
    ...(hasAddressId ? { address_id: body.address_id as string } : { address }),
    attachment_keys: attachmentKeys,
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
  };
}

function localDateParts(date: string): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new BadRequestError('date debe tener formato YYYY-MM-DD.', 'VALIDATION_ERROR');
  const [year, month, day] = date.split('-').map(Number);
  const check = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month! - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new BadRequestError('date no es una fecha válida.', 'VALIDATION_ERROR');
  }
  return { year: year!, month: month!, day: day!, dayOfWeek: check.getUTCDay() };
}

function localDateTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const difference = target - represented;
    guess += difference;
    if (difference === 0) break;
  }
  return new Date(guess);
}

function utcToLocal(
  date: Date,
  timeZone: string,
): { date: string; time: string; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    dayOfWeek: weekdays[parts.weekday!]!,
  };
}

async function loadAvailability(branchId: bigint, categoryId: bigint, date: string) {
  const { dayOfWeek } = localDateParts(date);
  const [branch] = await db.select().from(branches).where(eq(branches.UniqueID, branchId)).limit(1);
  if (!branch) throw new NotFoundError('La sucursal no existe.');
  if (!branch.accepting_request) {
    return {
      branch,
      price: null,
      duration: null,
      slots: [] as Array<{ starts_at: string; ends_at: string }>,
    };
  }

  const [categoryPrice] = await db
    .select({
      price: branches_categories.base_price,
      duration: branches_categories.duration_minutes,
    })
    .from(branches_categories)
    .innerJoin(categories, eq(branches_categories.category_id, categories.UniqueID))
    .where(
      and(
        eq(branches_categories.branch_id, branchId),
        eq(branches_categories.category_id, categoryId),
        eq(branches_categories.active, true),
        eq(categories.active, true),
      ),
    )
    .limit(1);
  if (!categoryPrice) throw new NotFoundError('La categoría no está disponible en esta sucursal.');
  if (categoryPrice.duration <= 0)
    throw new BadRequestError(
      'La duración configurada para la categoría no es válida.',
      'INVALID_CATEGORY_DURATION',
    );

  const schedules = await db
    .select()
    .from(branch_schedules)
    .where(
      and(
        eq(branch_schedules.branch_id, branchId),
        eq(branch_schedules.day_of_week, dayOfWeek),
        eq(branch_schedules.active, true),
      ),
    )
    .orderBy(asc(branch_schedules.open_time));
  if (!schedules.length)
    return {
      branch,
      price: categoryPrice.price,
      duration: categoryPrice.duration,
      slots: [] as Array<{ starts_at: string; ends_at: string }>,
    };

  const activeEmployees = await db
    .select({ id: employees.UniqueID })
    .from(employees)
    .where(
      and(
        eq(employees.branch_id, branchId),
        eq(employees.active, true),
        eq(employees.can_attend, true),
      ),
    );
  if (!activeEmployees.length)
    return {
      branch,
      price: categoryPrice.price,
      duration: categoryPrice.duration,
      slots: [] as Array<{ starts_at: string; ends_at: string }>,
    };

  const employeeIds = activeEmployees.map((employee) => employee.id);
  const ranges = schedules
    .map((schedule) => ({
      start: localDateTimeToUtc(date, schedule.open_time, branch.timezone),
      end: localDateTimeToUtc(date, schedule.close_time, branch.timezone),
    }))
    .filter((range) => range.end > range.start);
  if (!ranges.length)
    return {
      branch,
      price: categoryPrice.price,
      duration: categoryPrice.duration,
      slots: [] as Array<{ starts_at: string; ends_at: string }>,
    };
  const dayStart = new Date(Math.min(...ranges.map((range) => range.start.getTime())));
  const dayEnd = new Date(Math.max(...ranges.map((range) => range.end.getTime())));

  const blocks = await db
    .select({
      employeeId: schedule_blocks.employee_id,
      start: schedule_blocks.starts_at,
      end: schedule_blocks.ends_at,
    })
    .from(schedule_blocks)
    .where(
      and(
        inArray(schedule_blocks.employee_id, employeeIds),
        lt(schedule_blocks.starts_at, dayEnd),
        gte(schedule_blocks.ends_at, dayStart),
      ),
    );
  const bookings = await db
    .select({
      employeeId: service_requests.employee_id,
      start: service_requests.scheduled_at,
      end: service_requests.scheduled_end,
      categoryId: service_requests.category_id,
    })
    .from(service_requests)
    .where(
      and(
        inArray(service_requests.employee_id, employeeIds),
        isNotNull(service_requests.scheduled_at),
        gte(service_requests.scheduled_at, new Date(dayStart.getTime() - 24 * 60 * 60_000)),
        lt(service_requests.scheduled_at, dayEnd),
        inArray(service_requests.status, ['pendiente', ...ACTIVE_BOOKING_STATUSES]),
      ),
    );
  const durationRows = await db
    .select({
      categoryId: branches_categories.category_id,
      duration: branches_categories.duration_minutes,
    })
    .from(branches_categories)
    .where(eq(branches_categories.branch_id, branchId));
  const durationByCategory = new Map(
    durationRows.map((row) => [row.categoryId.toString(), row.duration]),
  );
  const now = Date.now();
  const slots = new Map<number, { starts_at: string; ends_at: string }>();

  for (const range of ranges) {
    const interval = SLOT_INTERVAL_MINUTES * 60_000;
    for (
      let startMs = range.start.getTime();
      startMs + categoryPrice.duration * 60_000 <= range.end.getTime();
      startMs += interval
    ) {
      if (startMs <= now) continue;
      const endMs = startMs + categoryPrice.duration * 60_000;
      const freeEmployee = employeeIds.some((employeeId) => {
        const hasBlock = blocks.some(
          (block) =>
            block.employeeId === employeeId &&
            block.start.getTime() < endMs &&
            block.end.getTime() > startMs,
        );
        if (hasBlock) return false;
        return !bookings.some((booking) => {
          if (booking.employeeId !== employeeId || !booking.start) return false;
          const bookingDuration = durationByCategory.get(booking.categoryId.toString()) ?? 60;
          const bookingEnd =
            booking.end ?? new Date(booking.start.getTime() + bookingDuration * 60_000);
          return booking.start.getTime() < endMs && bookingEnd.getTime() > startMs;
        });
      });
      if (freeEmployee)
        slots.set(startMs, {
          starts_at: new Date(startMs).toISOString(),
          ends_at: new Date(endMs).toISOString(),
        });
    }
  }
  return {
    branch,
    price: categoryPrice.price,
    duration: categoryPrice.duration,
    slots: [...slots.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  };
}

export async function getBranchAvailability(branchId: bigint, categoryId: bigint, date: string) {
  const result = await loadAvailability(branchId, categoryId, date);
  return result.slots;
}

async function validatePhotoKeys(keys: string[], ownerId: string) {
  const attachments: Array<{
    file_key: string;
    mime_type: (typeof IMAGE_MIME_TYPES)[number];
    size_bytes: number;
  }> = [];
  for (const key of keys) {
    if (
      !key.replace(/\\/g, '/').startsWith(`photos/${ownerId}/`) ||
      storageService.getFileOwnerId(key) !== ownerId
    ) {
      throw new ForbiddenError(
        'Solo puedes adjuntar fotografías que hayas subido a tu propia cuenta.',
        'FILE_NOT_OWNED',
      );
    }
    const file = await storageService.getFileForDownload(key);
    if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType)) {
      throw new BadRequestError(
        'Las solicitudes solo aceptan fotografías JPEG, PNG o WebP.',
        'INVALID_ATTACHMENT_TYPE',
      );
    }
    attachments.push({
      file_key: key,
      mime_type: file.mimeType as (typeof IMAGE_MIME_TYPES)[number],
      size_bytes: file.sizeBytes,
    });
  }
  return attachments;
}

async function findAvailableEmployee(
  tx: DbTransaction,
  branchId: bigint,
  scheduledAt: Date,
  scheduledEnd: Date,
  timeZone: string,
) {
  const local = utcToLocal(scheduledAt, timeZone);
  const { dayOfWeek } = localDateParts(local.date);
  const schedules = await tx
    .select({ open: branch_schedules.open_time, close: branch_schedules.close_time })
    .from(branch_schedules)
    .where(
      and(
        eq(branch_schedules.branch_id, branchId),
        eq(branch_schedules.day_of_week, dayOfWeek),
        eq(branch_schedules.active, true),
      ),
    );
  const localStart = local.time;
  const localEnd = utcToLocal(scheduledEnd, timeZone);
  if (
    !schedules.some(
      (item: { open: string; close: string }) =>
        localStart >= item.open.slice(0, 5) &&
        localEnd.date === local.date &&
        localEnd.time <= item.close.slice(0, 5),
    )
  )
    return null;

  const candidates = await tx
    .select({ id: employees.UniqueID })
    .from(employees)
    .where(
      and(
        eq(employees.branch_id, branchId),
        eq(employees.active, true),
        eq(employees.can_attend, true),
      ),
    )
    .for('update');
  for (const candidate of candidates) {
    const [block] = await tx
      .select({ id: schedule_blocks.UniqueID })
      .from(schedule_blocks)
      .where(
        and(
          eq(schedule_blocks.employee_id, candidate.id),
          lt(schedule_blocks.starts_at, scheduledEnd),
          gt(schedule_blocks.ends_at, scheduledAt),
        ),
      )
      .limit(1);
    if (block) continue;
    const [booking] = await tx
      .select({ id: service_requests.UniqueID })
      .from(service_requests)
      .where(
        and(
          eq(service_requests.employee_id, candidate.id),
          isNotNull(service_requests.scheduled_at),
          inArray(service_requests.status, ['pendiente', ...ACTIVE_BOOKING_STATUSES]),
          lt(service_requests.scheduled_at, scheduledEnd),
          sql`coalesce(${service_requests.scheduled_end}, ${service_requests.scheduled_at} + interval '1 hour') > ${sql.param(scheduledAt, service_requests.scheduled_at)}`,
        ),
      )
      .limit(1);
    if (!booking) return candidate.id as bigint;
  }
  return null;
}

export async function createServiceRequest(actor: { id: string; role: string }, rawInput: unknown) {
  if (actor.role.trim().toLowerCase() !== 'cliente')
    throw new ForbiddenError(
      'Solo un cliente puede crear solicitudes de servicio.',
      'INSUFFICIENT_PERMISSIONS',
    );
  const input = parseCreateInput(rawInput);
  const clientId = idToBigint(actor.id, 'user_id');
  const branchId = idToBigint(input.branch_id, 'branch_id');
  const categoryId = idToBigint(input.category_id, 'category_id');

  const [existing] = await db
    .select({ id: service_requests.UniqueID })
    .from(service_requests)
    .where(
      and(
        eq(service_requests.client_id, clientId),
        eq(service_requests.client_uuid, input.client_uuid),
      ),
    )
    .limit(1);
  if (existing) return await getServiceRequest(existing.id, actor);

  const photos = await validatePhotoKeys(input.attachment_keys ?? [], actor.id);
  const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null;
  if (scheduledAt && scheduledAt.getTime() <= Date.now())
    throw new BadRequestError('scheduled_at debe ser una fecha futura.', 'VALIDATION_ERROR');
  if (scheduledAt) {
    const [scheduledBranch] = await db
      .select({ timezone: branches.timezone, accepting: branches.accepting_request })
      .from(branches)
      .where(eq(branches.UniqueID, branchId))
      .limit(1);
    if (!scheduledBranch) throw new NotFoundError('La sucursal no existe.');
    if (!scheduledBranch.accepting)
      throw new ConflictError(
        'La sucursal no acepta solicitudes actualmente.',
        'BRANCH_NOT_AVAILABLE',
      );
    const localDate = utcToLocal(scheduledAt, scheduledBranch.timezone).date;
    const availability = await loadAvailability(branchId, categoryId, localDate);
    if (
      !availability.slots.some(
        (slot) => new Date(slot.starts_at).getTime() === scheduledAt.getTime(),
      )
    ) {
      throw new ConflictError('El horario seleccionado ya no está libre.', 'SLOT_TAKEN');
    }
  }

  try {
    const createdId = await db.transaction(async (tx) => {
      const [branch] = await tx
        .select()
        .from(branches)
        .where(eq(branches.UniqueID, branchId))
        .limit(1);
      if (!branch) throw new NotFoundError('La sucursal no existe.');
      if (!branch.accepting_request)
        throw new ConflictError(
          'La sucursal no acepta solicitudes actualmente.',
          'BRANCH_NOT_AVAILABLE',
        );

      const [priceRow] = await tx
        .select({
          price: branches_categories.base_price,
          duration: branches_categories.duration_minutes,
        })
        .from(branches_categories)
        .innerJoin(categories, eq(branches_categories.category_id, categories.UniqueID))
        .where(
          and(
            eq(branches_categories.branch_id, branchId),
            eq(branches_categories.category_id, categoryId),
            eq(branches_categories.active, true),
            eq(categories.active, true),
          ),
        )
        .limit(1);
      if (!priceRow) throw new NotFoundError('La categoría no está disponible en esta sucursal.');

      let addressId: bigint;
      if (input.address_id) {
        addressId = idToBigint(input.address_id, 'address_id');
        const [ownedAddress] = await tx
          .select({ id: address_user.address_id })
          .from(address_user)
          .where(
            and(
              eq(address_user.user_id, clientId),
              eq(address_user.address_id, addressId),
              eq(address_user.active, true),
            ),
          )
          .limit(1);
        if (!ownedAddress)
          throw new NotFoundError('La dirección guardada no existe o no pertenece al cliente.');
      } else {
        const address = input.address!;
        const [insertedAddress] = await tx
          .insert(addresses)
          .values({
            reference: address.reference?.trim() || null,
            street: address.street.trim(),
            num_ext: address.num_ext.trim(),
            num_int: address.num_int?.trim() || null,
            colony: address.colony.trim(),
            municipality: address.municipality.trim(),
            state: address.state.trim(),
            postal_code: address.postal_code.trim(),
            country: address.country?.trim() || 'México',
            latitude:
              address.latitude === undefined || address.latitude === null
                ? null
                : String(address.latitude),
            longitude:
              address.longitude === undefined || address.longitude === null
                ? null
                : String(address.longitude),
          })
          .returning({ id: addresses.UniqueID });
        addressId = insertedAddress!.id;
        if (address.is_main === true) {
          await tx
            .update(address_user)
            .set({ is_main: false })
            .where(eq(address_user.user_id, clientId));
        }
        await tx.insert(address_user).values({
          user_id: clientId,
          address_id: addressId,
          alias: address.alias?.trim() || 'Casa',
          is_main: address.is_main ?? false,
          active: true,
        });
      }

      let employeeId: bigint | null = null;
      let scheduledEnd: Date | null = null;
      if (scheduledAt) {
        scheduledEnd = new Date(scheduledAt.getTime() + priceRow.duration * 60_000);
        employeeId = await findAvailableEmployee(
          tx,
          branchId,
          scheduledAt,
          scheduledEnd,
          branch.timezone,
        );
        if (!employeeId)
          throw new ConflictError('El horario seleccionado ya no está libre.', 'SLOT_TAKEN');
      }

      const now = new Date();
      const [request] = await tx
        .insert(service_requests)
        .values({
          client_id: clientId,
          category_id: categoryId,
          branch_id: branchId,
          address_id: addressId,
          employee_id: employeeId,
          is_emergency: false,
          description: input.description,
          status: 'pendiente',
          expires_at: scheduledAt ? null : new Date(now.getTime() + 5 * 60_000),
          agreed_price: priceRow.price,
          client_uuid: input.client_uuid,
          scheduled_at: scheduledAt,
          scheduled_end: scheduledEnd,
          created_at: now,
        })
        .returning({ id: service_requests.UniqueID });
      const requestId = request!.id;

      if (photos.length) {
        await tx.insert(request_attachments).values(
          photos.map((photo) => ({
            request_id: requestId,
            file_key: photo.file_key,
            mime_type: photo.mime_type,
            size_bytes: photo.size_bytes,
            kind: 'solicitud' as const,
          })),
        );
      }
      await tx.insert(service_request_events).values({
        request_id: requestId,
        from_status: null,
        to_status: 'pendiente',
        changed_by: clientId,
      });
      return { id: requestId, employeeId };
    });

    if (!scheduledAt) {
      try {
        await timerService.start(redisKeys.requestTimer(createdId.id), 5 * 60);
      } catch (error) {
        // expires_at queda persistido en PostgreSQL aunque Redis no esté disponible temporalmente.
        console.error('[API-27] No se pudo iniciar el temporizador Redis de la solicitud:', error);
      }
    }

    await eventBus.notify(
      new ServiceRequestStatusChangedEvent({
        requestId: createdId.id.toString(),
        fromStatus: null,
        toStatus: 'pendiente',
        changedBy: actor.id,
        clientId: actor.id,
        employeeId: createdId.employeeId?.toString() ?? null,
        branchId: branchId.toString(),
        historyPersisted: true,
      }),
    );
    return await getServiceRequest(createdId.id, actor);
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === '23505' && databaseError.constraint?.includes('client_uuid')) {
      const [duplicate] = await db
        .select({ id: service_requests.UniqueID })
        .from(service_requests)
        .where(
          and(
            eq(service_requests.client_id, clientId),
            eq(service_requests.client_uuid, input.client_uuid),
          ),
        )
        .limit(1);
      if (duplicate) return await getServiceRequest(duplicate.id, actor);
    }
    throw error;
  }
}
