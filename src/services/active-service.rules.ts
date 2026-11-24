import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
  employee_profiles,
  employee_vehicles,
  employees,
  personal_data,
  service_requests,
} from '../database/schema/tables.ts';
import { ConflictError } from '../errors/app-error.ts';
import type { DbExecutor } from './price-adjustment.rules.ts';

/**
 * API-55: reglas de identidad durante un servicio, como en las apps de viajes.
 *
 * Desde que el técnico acepta hasta que el servicio termina o se cancela, el cliente y el técnico
 * ya se conocen por nombre, foto y vehículo. Esos datos se congelan: se guarda una copia en la
 * solicitud y no se pueden editar en el perfil mientras el servicio siga activo.
 */

/** Con técnico asignado y sin terminar. `en_curso` es el nombre anterior de `en_camino`. */
export const ACTIVE_SERVICE_STATUSES = [
  'aceptada',
  'agendada',
  'en_curso',
  'en_camino',
  'llegado',
] as const;

export const ACTIVE_SERVICE_LOCK = 'ACTIVE_SERVICE_LOCK';

/** El error cuando se intenta cambiar un dato congelado; [own] es si la cuenta edita lo suyo. */
export function activeServiceLockError(what: string, own = true): ConflictError {
  return new ConflictError(
    own
      ? `No puedes cambiar ${what} mientras tienes un servicio en curso. Podrás hacerlo cuando termine.`
      : `No se puede cambiar ${what} del técnico mientras tiene un servicio en curso.`,
    ACTIVE_SERVICE_LOCK,
  );
}

/** Nombre y apellido paterno, como se muestra a la otra parte. */
export function displayName(data: { name: string; lastname_p: string } | null | undefined): string {
  return data ? `${data.name} ${data.lastname_p}`.trim() : '';
}

/** ¿El técnico tiene una solicitud asignada que sigue activa? */
export async function employeeHasActiveService(
  employeeId: bigint,
  executor: DbExecutor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: service_requests.UniqueID })
    .from(service_requests)
    .where(
      and(
        eq(service_requests.employee_id, employeeId),
        inArray(service_requests.status, [...ACTIVE_SERVICE_STATUSES]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** ¿La cuenta tiene un servicio activo, como cliente o como técnico de alguna sucursal? */
export async function userHasActiveService(
  userId: bigint,
  executor: DbExecutor = db,
): Promise<boolean> {
  const [asClient] = await executor
    .select({ id: service_requests.UniqueID })
    .from(service_requests)
    .where(
      and(
        eq(service_requests.client_id, userId),
        inArray(service_requests.status, [...ACTIVE_SERVICE_STATUSES]),
      ),
    )
    .limit(1);
  if (asClient) return true;

  const [asTechnician] = await executor
    .select({ id: service_requests.UniqueID })
    .from(service_requests)
    .innerJoin(employees, eq(service_requests.employee_id, employees.UniqueID))
    .where(
      and(
        eq(employees.user_id, userId),
        inArray(service_requests.status, [...ACTIVE_SERVICE_STATUSES]),
      ),
    )
    .limit(1);
  return Boolean(asTechnician);
}

export async function assertUserHasNoActiveService(userId: bigint, what: string): Promise<void> {
  if (await userHasActiveService(userId)) throw activeServiceLockError(what);
}

/** [own] es false cuando el dueño o el gerente editan el perfil de un técnico de su sucursal. */
export async function assertEmployeeHasNoActiveService(
  employeeId: bigint,
  what: 'foto' | 'vehículo',
  own: boolean,
): Promise<void> {
  if (!(await employeeHasActiveService(employeeId))) return;
  const article = what === 'foto' ? 'la' : 'el';
  throw activeServiceLockError(own ? `tu ${what}` : `${article} ${what}`, own);
}

/** Las columnas de service_requests con la copia de ambas partes al momento de aceptar. */
export async function partySnapshot(executor: DbExecutor, employeeId: bigint, clientId: bigint) {
  const [technician] = await executor
    .select({ name: personal_data.name, lastname_p: personal_data.lastname_p })
    .from(employees)
    .innerJoin(personal_data, eq(personal_data.user_id, employees.user_id))
    .where(eq(employees.UniqueID, employeeId))
    .limit(1);
  const [profile] = await executor
    .select({ photo_key: employee_profiles.photo_key })
    .from(employee_profiles)
    .where(eq(employee_profiles.employee_id, employeeId))
    .limit(1);
  const [vehicle] = await executor
    .select()
    .from(employee_vehicles)
    .where(and(eq(employee_vehicles.employee_id, employeeId), eq(employee_vehicles.active, true)))
    .limit(1);
  const [client] = await executor
    .select({ name: personal_data.name, lastname_p: personal_data.lastname_p })
    .from(personal_data)
    .where(eq(personal_data.user_id, clientId))
    .limit(1);

  return {
    technician_name: displayName(technician),
    technician_photo_key: profile?.photo_key ?? null,
    vehicle_plate: vehicle?.plate ?? null,
    vehicle_brand: vehicle?.brand ?? null,
    vehicle_model: vehicle?.model ?? null,
    vehicle_color: vehicle?.color ?? null,
    client_name: displayName(client),
  };
}

export interface VehicleView {
  plate: string;
  brand: string;
  model: string;
  color: string;
}

type SnapshotColumns = Pick<
  typeof service_requests.$inferSelect,
  | 'technician_name'
  | 'technician_photo_key'
  | 'vehicle_plate'
  | 'vehicle_brand'
  | 'vehicle_model'
  | 'vehicle_color'
  | 'client_name'
>;

/**
 * Qué se muestra de cada parte: la copia si la solicitud ya se aceptó con API-55; si no (pendiente
 * o anterior a la copia), los datos actuales del perfil.
 */
export function partiesToShow(
  request: SnapshotColumns,
  live: {
    technicianName: string;
    technicianPhotoKey: string | null;
    vehicle: VehicleView | null;
    clientName: string;
  },
) {
  const frozen = request.technician_name !== null;
  return {
    technicianName: frozen ? request.technician_name! : live.technicianName,
    technicianPhotoKey: frozen ? request.technician_photo_key : live.technicianPhotoKey,
    vehicle: frozen
      ? request.vehicle_plate
        ? {
            plate: request.vehicle_plate,
            brand: request.vehicle_brand ?? '',
            model: request.vehicle_model ?? '',
            color: request.vehicle_color ?? '',
          }
        : null
      : live.vehicle,
    clientName: request.client_name ?? live.clientName,
  };
}
