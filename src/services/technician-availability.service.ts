import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { branches, branch_schedules, employees } from '../database/schema/tables.ts';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import type {
  ScheduleCheckResult,
  TechnicianAvailabilityInput,
  TechnicianAvailabilityResponse,
} from '../types/technician-availability.types.ts';

export const TECHNICIAN_ONLINE_TTL_SECONDS = 300; // 5 minutos de expiración de heartbeat

/**
 * Evalúa si una sucursal está dentro de su horario de atención y si acepta solicitudes.
 * Función pura y determinista con soporte de zonas horarias.
 */
export function checkBranchSchedule(
  branch: { accepting_request: boolean; timezone: string },
  schedules: { day_of_week: number; open_time: string; close_time: string; active: boolean }[],
  now = new Date(),
): ScheduleCheckResult {
  if (!branch.accepting_request) {
    return {
      isOpen: false,
      reason: 'NOT_ACCEPTING_REQUESTS',
      message: 'La sucursal tiene deshabilitada la recepción de solicitudes en este momento.',
    };
  }

  const tz = branch.timezone || 'America/Mexico_City';

  // Descomponer fecha y hora actual en la zona horaria de la sucursal
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const dayOfWeek = weekdayMap[partMap.weekday] ?? now.getDay();
  const hour = parseInt(partMap.hour, 10);
  const minute = parseInt(partMap.minute, 10);
  const currentMinutes = hour * 60 + minute;
  const currentTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const daySchedule = schedules.find((s) => s.day_of_week === dayOfWeek && s.active);
  if (!daySchedule) {
    return {
      isOpen: false,
      reason: 'NO_SCHEDULE_TODAY',
      message: 'La sucursal no tiene horario de atención configurado para hoy.',
      currentDayOfWeek: dayOfWeek,
      currentTime,
    };
  }

  const [openH, openM] = daySchedule.open_time.split(':').map(Number);
  const [closeH, closeM] = daySchedule.close_time.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  if (currentMinutes < openMinutes || currentMinutes >= closeMinutes) {
    return {
      isOpen: false,
      reason: 'OUTSIDE_HOURS',
      message: `Fuera del horario de atención de la sucursal (${daySchedule.open_time.slice(0, 5)} - ${daySchedule.close_time.slice(0, 5)}). Hora actual: ${currentTime}.`,
      currentDayOfWeek: dayOfWeek,
      currentTime,
    };
  }

  return {
    isOpen: true,
    currentDayOfWeek: dayOfWeek,
    currentTime,
  };
}

export class TechnicianAvailabilityService {
  /**
   * Obtiene la disponibilidad actual del técnico en Redis y el estado de su sucursal.
   */
  async getTechnicianAvailability(
    employeeIdInput: string | bigint,
  ): Promise<TechnicianAvailabilityResponse> {
    const employeeId = BigInt(employeeIdInput);

    const [emp] = await db
      .select({
        id: employees.UniqueID,
        userId: employees.user_id,
        branchId: employees.branch_id,
        canAttend: employees.can_attend,
        active: employees.active,
        branchAccepting: branches.accepting_request,
        branchTimezone: branches.timezone,
      })
      .from(employees)
      .innerJoin(branches, eq(employees.branch_id, branches.UniqueID))
      .where(eq(employees.UniqueID, employeeId))
      .limit(1);

    if (!emp) {
      throw new NotFoundError('Técnico no encontrado.');
    }

    // Consultar horarios de la sucursal para verificar si está abierta
    const schedules = await db
      .select({
        day_of_week: branch_schedules.day_of_week,
        open_time: branch_schedules.open_time,
        close_time: branch_schedules.close_time,
        active: branch_schedules.active,
      })
      .from(branch_schedules)
      .where(eq(branch_schedules.branch_id, emp.branchId));

    const scheduleCheck = checkBranchSchedule(
      { accepting_request: emp.branchAccepting, timezone: emp.branchTimezone },
      schedules,
    );

    // Consultar Redis
    let onlineDataRaw: string | null;
    let ttl: number;
    try {
      onlineDataRaw = await redis.get(redisKeys.technicianOnline(employeeId));
      const rawTtl = await redis.ttl(redisKeys.technicianOnline(employeeId));
      ttl = rawTtl < 0 ? 0 : rawTtl;
    } catch {
      // Si Redis no responde, se reporta fuera de línea
      onlineDataRaw = null;
      ttl = 0;
    }

    let isOnline = false;
    let location: { latitude: number; longitude: number } | null = null;
    let updatedAt: string | null = null;

    if (onlineDataRaw) {
      try {
        const parsed = JSON.parse(onlineDataRaw) as {
          online?: boolean;
          latitude?: number;
          longitude?: number;
          updated_at?: string;
        };
        isOnline = Boolean(parsed.online);
        if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
          location = { latitude: parsed.latitude, longitude: parsed.longitude };
        }
        updatedAt = parsed.updated_at || null;
      } catch {
        isOnline = true;
      }
    }

    return {
      employee_id: emp.id.toString(),
      user_id: emp.userId.toString(),
      branch_id: emp.branchId.toString(),
      online: isOnline,
      location,
      branch: {
        id: emp.branchId.toString(),
        accepting_request: emp.branchAccepting,
        is_open: scheduleCheck.isOpen,
        current_time: scheduleCheck.currentTime,
      },
      expires_in_seconds: ttl,
      updated_at: updatedAt,
    };
  }

  /**
   * Actualiza el interruptor En línea / Fuera de línea y la posición geográfica en Redis.
   * Reglas de negocio:
   * - Respeta accepting_request de la sucursal (409 si false).
   * - Respeta horario de atención de la sucursal (409 si fuera de horario).
   * - La posición se almacena en el índice geográfico de Redis con TTL (nunca en PostgreSQL).
   */
  async updateTechnicianAvailability(
    employeeIdInput: string | bigint,
    input: TechnicianAvailabilityInput,
    now = new Date(),
  ): Promise<TechnicianAvailabilityResponse> {
    // 1. Validaciones previas de entrada (Fail fast)
    if (input.online) {
      if (typeof input.latitude !== 'number' || typeof input.longitude !== 'number') {
        throw new BadRequestError(
          'Para ponerse en línea debes enviar tu ubicación actual válida (latitude y longitude).',
        );
      }

      if (input.latitude < -90 || input.latitude > 90) {
        throw new BadRequestError('La latitud debe estar entre -90 y 90 grados.');
      }

      if (input.longitude < -180 || input.longitude > 180) {
        throw new BadRequestError('La longitud debe estar entre -180 y 180 grados.');
      }
    }

    const employeeId = BigInt(employeeIdInput);

    // 2. Validar existencia y permisos del técnico
    const [emp] = await db
      .select({
        id: employees.UniqueID,
        userId: employees.user_id,
        branchId: employees.branch_id,
        canAttend: employees.can_attend,
        active: employees.active,
        branchAccepting: branches.accepting_request,
        branchTimezone: branches.timezone,
      })
      .from(employees)
      .innerJoin(branches, eq(employees.branch_id, branches.UniqueID))
      .where(eq(employees.UniqueID, employeeId))
      .limit(1);

    if (!emp) {
      throw new NotFoundError('Técnico no encontrado.');
    }

    if (!emp.active) {
      throw new ForbiddenError('El perfil de técnico está inactivo.');
    }

    if (!emp.canAttend) {
      throw new ForbiddenError('El técnico no tiene permisos para atender solicitudes.');
    }

    // 3. Si intenta ponerse en línea, validar horario y accepting_request
    if (input.online) {
      const latitude = input.latitude as number;
      const longitude = input.longitude as number;

      const schedules = await db
        .select({
          day_of_week: branch_schedules.day_of_week,
          open_time: branch_schedules.open_time,
          close_time: branch_schedules.close_time,
          active: branch_schedules.active,
        })
        .from(branch_schedules)
        .where(eq(branch_schedules.branch_id, emp.branchId));

      const scheduleCheck = checkBranchSchedule(
        { accepting_request: emp.branchAccepting, timezone: emp.branchTimezone },
        schedules,
        now,
      );

      if (!scheduleCheck.isOpen) {
        if (scheduleCheck.reason === 'NOT_ACCEPTING_REQUESTS') {
          throw new AppError(
            'La sucursal tiene deshabilitada la recepción de solicitudes en este momento.',
            409,
            'BRANCH_NOT_ACCEPTING_REQUESTS',
          );
        }

        throw new AppError(
          scheduleCheck.message ||
            'No puedes ponerte en línea fuera del horario de atención de la sucursal.',
          409,
          'OUTSIDE_BRANCH_SCHEDULE',
        );
      }

      // 3. Guardar en Redis: índice geográfico y clave de disponibilidad con TTL
      try {
        await redis.geoAdd(redisKeys.technicianPositions(), {
          longitude,
          latitude,
          member: employeeId.toString(),
        });

        const payload = JSON.stringify({
          online: true,
          branch_id: emp.branchId.toString(),
          latitude,
          longitude,
          updated_at: now.toISOString(),
        });

        await redis.set(redisKeys.technicianOnline(employeeId), payload, {
          expiration: { type: 'EX', value: TECHNICIAN_ONLINE_TTL_SECONDS },
        });
      } catch {
        throw new AppError(
          'No se pudo actualizar la posición en Redis. Servicio temporalmente no disponible.',
          503,
          'REDIS_SERVICE_UNAVAILABLE',
        );
      }

      return {
        employee_id: emp.id.toString(),
        user_id: emp.userId.toString(),
        branch_id: emp.branchId.toString(),
        online: true,
        location: { latitude, longitude },
        branch: {
          id: emp.branchId.toString(),
          accepting_request: emp.branchAccepting,
          is_open: true,
          current_time: scheduleCheck.currentTime,
        },
        expires_in_seconds: TECHNICIAN_ONLINE_TTL_SECONDS,
        updated_at: now.toISOString(),
      };
    }

    // 4. Si se pone fuera de línea (online: false), remover del índice geográfico y borrar clave
    try {
      await redis.zRem(redisKeys.technicianPositions(), employeeId.toString());
      await redis.del(redisKeys.technicianOnline(employeeId));
    } catch {
      // Ignorar fallo al borrar si Redis no responde
    }

    return {
      employee_id: emp.id.toString(),
      user_id: emp.userId.toString(),
      branch_id: emp.branchId.toString(),
      online: false,
      location: null,
      branch: {
        id: emp.branchId.toString(),
        accepting_request: emp.branchAccepting,
        is_open: true,
      },
      expires_in_seconds: 0,
      updated_at: now.toISOString(),
    };
  }

  /**
   * Resuelve el técnico asociado al usuario autenticado.
   */
  async getEmployeeForUser(userId: string | bigint): Promise<bigint> {
    const [emp] = await db
      .select({ id: employees.UniqueID })
      .from(employees)
      .where(and(eq(employees.user_id, BigInt(userId)), eq(employees.active, true)))
      .limit(1);

    if (!emp) {
      throw new NotFoundError('No tienes un perfil de técnico asignado a una sucursal.');
    }

    return emp.id;
  }

  /**
   * Consulta disponibilidad del usuario autenticado.
   */
  async getMyAvailability(user: AuthenticatedUser): Promise<TechnicianAvailabilityResponse> {
    const employeeId = await this.getEmployeeForUser(user.id);
    return this.getTechnicianAvailability(employeeId);
  }

  /**
   * Actualiza disponibilidad del usuario autenticado.
   */
  async updateMyAvailability(
    user: AuthenticatedUser,
    input: TechnicianAvailabilityInput,
    now = new Date(),
  ): Promise<TechnicianAvailabilityResponse> {
    const employeeId = await this.getEmployeeForUser(user.id);
    return this.updateTechnicianAvailability(employeeId, input, now);
  }
}

export const technicianAvailabilityService = new TechnicianAvailabilityService();
