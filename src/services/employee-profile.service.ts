import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  branches,
  employees,
  employee_profiles,
  employee_vehicles,
  personal_data,
  roles,
  users,
} from '../database/schema/tables.ts';
import { BadRequestError, NotFoundError } from '../errors/app-error.ts';
import { checkBranchAccess } from './portfolio.service.ts';
import { storageService } from './storage.service.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import type {
  EmployeeDetailResponse,
  EmployeeProfileInput,
  EmployeeProfileResponse,
  EmployeeVehicleInput,
  EmployeeVehicleResponse,
} from '../types/portfolio.types.ts';

export class EmployeeProfileService {
  /**
   * Valida acceso a los datos del empleado.
   * Permitido para:
   * - Administrador
   * - El propio empleado
   * - Gerente de la sucursal del empleado
   * - Proveedor dueño del negocio al que pertenece la sucursal
   */
  async checkEmployeeAccess(
    employeeId: bigint,
    user: AuthenticatedUser,
  ): Promise<{ employeeId: bigint; userId: bigint; branchId: bigint }> {
    const [emp] = await db
      .select({
        id: employees.UniqueID,
        userId: employees.user_id,
        branchId: employees.branch_id,
      })
      .from(employees)
      .where(eq(employees.UniqueID, employeeId))
      .limit(1);

    if (!emp) {
      throw new NotFoundError('Empleado no encontrado.');
    }

    if (user.role === 'administrador') {
      return { employeeId: emp.id, userId: emp.userId, branchId: emp.branchId };
    }

    // El propio usuario asignado como empleado
    if (emp.userId === BigInt(user.id)) {
      return { employeeId: emp.id, userId: emp.userId, branchId: emp.branchId };
    }

    // Dueño o gerente de la sucursal
    await checkBranchAccess(emp.branchId, user);
    return { employeeId: emp.id, userId: emp.userId, branchId: emp.branchId };
  }

  /**
   * Obtiene el detalle completo del empleado, incluyendo foto, biografía y vehículo.
   */
  async getEmployeeDetail(
    employeeIdInput: string | bigint,
    user: AuthenticatedUser,
  ): Promise<EmployeeDetailResponse> {
    const employeeId = BigInt(employeeIdInput);
    await this.checkEmployeeAccess(employeeId, user);

    const [row] = await db
      .select({
        id: employees.UniqueID,
        user_id: employees.user_id,
        branch_id: employees.branch_id,
        can_attend: employees.can_attend,
        active: employees.active,
        email: users.email,
        role: roles.name,
        name: personal_data.name,
        lastname_p: personal_data.lastname_p,
        lastname_m: personal_data.lastname_m,
        phone: personal_data.phone,
      })
      .from(employees)
      .innerJoin(users, eq(employees.user_id, users.UniqueID))
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
      .where(eq(employees.UniqueID, employeeId))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Empleado no encontrado.');
    }

    // Consultar perfil (foto y bio)
    const [profileRow] = await db
      .select({
        photo_key: employee_profiles.photo_key,
        bio: employee_profiles.bio,
      })
      .from(employee_profiles)
      .where(eq(employee_profiles.employee_id, employeeId))
      .limit(1);

    // Consultar vehículo activo
    const [vehicleRow] = await db
      .select({
        id: employee_vehicles.UniqueID,
        employee_id: employee_vehicles.employee_id,
        plate: employee_vehicles.plate,
        brand: employee_vehicles.brand,
        model: employee_vehicles.model,
        color: employee_vehicles.color,
        active: employee_vehicles.active,
      })
      .from(employee_vehicles)
      .where(and(eq(employee_vehicles.employee_id, employeeId), eq(employee_vehicles.active, true)))
      .limit(1);

    let photoUrl: string | null = null;
    if (profileRow?.photo_key) {
      try {
        photoUrl = storageService.generateSignedUrl({
          file_key: profileRow.photo_key,
          expires_in_minutes: 180,
        }).signed_url;
      } catch {
        photoUrl = null;
      }
    }

    return {
      id: row.id.toString(),
      user_id: row.user_id.toString(),
      branch_id: row.branch_id.toString(),
      email: row.email,
      name: row.name ?? '',
      lastname_p: row.lastname_p ?? '',
      lastname_m: row.lastname_m ?? null,
      phone: row.phone ?? null,
      role: row.role,
      can_attend: row.can_attend,
      active: row.active,
      profile: {
        photo_key: profileRow?.photo_key ?? null,
        photo_url: photoUrl,
        bio: profileRow?.bio ?? null,
      },
      vehicle: vehicleRow
        ? {
            id: vehicleRow.id.toString(),
            employee_id: vehicleRow.employee_id.toString(),
            plate: vehicleRow.plate,
            brand: vehicleRow.brand,
            model: vehicleRow.model,
            color: vehicleRow.color,
            active: vehicleRow.active,
          }
        : null,
    };
  }

  /**
   * Actualiza o crea la foto y biografía del empleado.
   */
  async updateEmployeeProfile(
    employeeIdInput: string | bigint,
    input: EmployeeProfileInput,
    user: AuthenticatedUser,
  ): Promise<EmployeeProfileResponse> {
    if (input.bio && input.bio.length > 1000) {
      throw new BadRequestError('La biografía no puede exceder los 1000 caracteres.');
    }

    const employeeId = BigInt(employeeIdInput);
    await this.checkEmployeeAccess(employeeId, user);

    const photoKey = input.photo_key !== undefined ? input.photo_key?.trim() || null : undefined;
    const bio = input.bio !== undefined ? input.bio?.trim() || null : undefined;

    const [existing] = await db
      .select({ id: employee_profiles.UniqueID, photo_key: employee_profiles.photo_key })
      .from(employee_profiles)
      .where(eq(employee_profiles.employee_id, employeeId))
      .limit(1);

    if (existing) {
      const updateData: Partial<typeof employee_profiles.$inferInsert> = {};
      if (photoKey !== undefined) updateData.photo_key = photoKey;
      if (bio !== undefined) updateData.bio = bio;

      await db
        .update(employee_profiles)
        .set(updateData)
        .where(eq(employee_profiles.UniqueID, existing.id));
    } else {
      await db.insert(employee_profiles).values({
        employee_id: employeeId,
        photo_key: photoKey ?? null,
        bio: bio ?? null,
      });
    }

    const [updated] = await db
      .select({
        photo_key: employee_profiles.photo_key,
        bio: employee_profiles.bio,
      })
      .from(employee_profiles)
      .where(eq(employee_profiles.employee_id, employeeId))
      .limit(1);

    let photoUrl: string | null = null;
    if (updated?.photo_key) {
      try {
        photoUrl = storageService.generateSignedUrl({
          file_key: updated.photo_key,
          expires_in_minutes: 180,
        }).signed_url;
      } catch {
        photoUrl = null;
      }
    }

    return {
      photo_key: updated?.photo_key ?? null,
      photo_url: photoUrl,
      bio: updated?.bio ?? null,
    };
  }

  /**
   * Obtiene el vehículo asignado al empleado.
   */
  async getEmployeeVehicle(
    employeeIdInput: string | bigint,
    user: AuthenticatedUser,
  ): Promise<EmployeeVehicleResponse | null> {
    const employeeId = BigInt(employeeIdInput);
    await this.checkEmployeeAccess(employeeId, user);

    const [vehicle] = await db
      .select({
        id: employee_vehicles.UniqueID,
        employee_id: employee_vehicles.employee_id,
        plate: employee_vehicles.plate,
        brand: employee_vehicles.brand,
        model: employee_vehicles.model,
        color: employee_vehicles.color,
        active: employee_vehicles.active,
      })
      .from(employee_vehicles)
      .where(and(eq(employee_vehicles.employee_id, employeeId), eq(employee_vehicles.active, true)))
      .limit(1);

    if (!vehicle) {
      return null;
    }

    return {
      id: vehicle.id.toString(),
      employee_id: vehicle.employee_id.toString(),
      plate: vehicle.plate,
      brand: vehicle.brand,
      model: vehicle.model,
      color: vehicle.color,
      active: vehicle.active,
    };
  }

  /**
   * Registra o actualiza el vehículo del empleado.
   */
  async updateEmployeeVehicle(
    employeeIdInput: string | bigint,
    input: EmployeeVehicleInput,
    user: AuthenticatedUser,
  ): Promise<EmployeeVehicleResponse> {
    if (!input.plate || typeof input.plate !== 'string' || !input.plate.trim()) {
      throw new BadRequestError('Los campos plate, brand, model y color son obligatorios.');
    }
    if (!input.brand || typeof input.brand !== 'string' || !input.brand.trim()) {
      throw new BadRequestError('Los campos plate, brand, model y color son obligatorios.');
    }
    if (!input.model || typeof input.model !== 'string' || !input.model.trim()) {
      throw new BadRequestError('Los campos plate, brand, model y color son obligatorios.');
    }
    if (!input.color || typeof input.color !== 'string' || !input.color.trim()) {
      throw new BadRequestError('Los campos plate, brand, model y color son obligatorios.');
    }

    const plate = input.plate.trim().toUpperCase();
    const brand = input.brand.trim();
    const model = input.model.trim();
    const color = input.color.trim();
    const active = input.active !== undefined ? Boolean(input.active) : true;

    const employeeId = BigInt(employeeIdInput);
    await this.checkEmployeeAccess(employeeId, user);

    const [existing] = await db
      .select({ id: employee_vehicles.UniqueID })
      .from(employee_vehicles)
      .where(eq(employee_vehicles.employee_id, employeeId))
      .limit(1);

    if (existing) {
      await db
        .update(employee_vehicles)
        .set({
          plate,
          brand,
          model,
          color,
          active,
        })
        .where(eq(employee_vehicles.UniqueID, existing.id));

      return {
        id: existing.id.toString(),
        employee_id: employeeId.toString(),
        plate,
        brand,
        model,
        color,
        active,
      };
    }

    const [inserted] = await db
      .insert(employee_vehicles)
      .values({
        employee_id: employeeId,
        plate,
        brand,
        model,
        color,
        active,
      })
      .returning({ id: employee_vehicles.UniqueID });

    return {
      id: inserted.id.toString(),
      employee_id: employeeId.toString(),
      plate,
      brand,
      model,
      color,
      active,
    };
  }

  /**
   * Desactiva el vehículo del empleado.
   */
  async deleteEmployeeVehicle(
    employeeIdInput: string | bigint,
    user: AuthenticatedUser,
  ): Promise<void> {
    const employeeId = BigInt(employeeIdInput);
    await this.checkEmployeeAccess(employeeId, user);

    await db
      .update(employee_vehicles)
      .set({ active: false })
      .where(eq(employee_vehicles.employee_id, employeeId));
  }

  /**
   * Lista todos los empleados de una sucursal, enriquecidos con su foto, biografía y vehículo.
   */
  async getBranchEmployees(
    branchIdInput: string | bigint,
    user: AuthenticatedUser,
  ): Promise<EmployeeDetailResponse[]> {
    const branchId = BigInt(branchIdInput);

    const [branch] = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .where(eq(branches.UniqueID, branchId))
      .limit(1);

    if (!branch) {
      throw new NotFoundError('Sucursal no encontrada.');
    }

    await checkBranchAccess(branchId, user);

    const employeeRows = await db
      .select({
        id: employees.UniqueID,
        user_id: employees.user_id,
        branch_id: employees.branch_id,
        can_attend: employees.can_attend,
        active: employees.active,
        email: users.email,
        role: roles.name,
        name: personal_data.name,
        lastname_p: personal_data.lastname_p,
        lastname_m: personal_data.lastname_m,
        phone: personal_data.phone,
      })
      .from(employees)
      .innerJoin(users, eq(employees.user_id, users.UniqueID))
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
      .where(and(eq(employees.branch_id, branchId), eq(employees.active, true)));

    if (employeeRows.length === 0) {
      return [];
    }

    const employeeIds = employeeRows.map((e) => e.id);

    const profileRows = await db
      .select({
        employee_id: employee_profiles.employee_id,
        photo_key: employee_profiles.photo_key,
        bio: employee_profiles.bio,
      })
      .from(employee_profiles)
      .where(
        employeeIds.length === 1 ? eq(employee_profiles.employee_id, employeeIds[0]) : undefined,
      );

    const vehicleRows = await db
      .select({
        id: employee_vehicles.UniqueID,
        employee_id: employee_vehicles.employee_id,
        plate: employee_vehicles.plate,
        brand: employee_vehicles.brand,
        model: employee_vehicles.model,
        color: employee_vehicles.color,
        active: employee_vehicles.active,
      })
      .from(employee_vehicles)
      .where(
        and(
          employeeIds.length === 1 ? eq(employee_vehicles.employee_id, employeeIds[0]) : undefined,
          eq(employee_vehicles.active, true),
        ),
      );

    return employeeRows.map((e) => {
      const prof = profileRows.find((p) => p.employee_id === e.id);
      const veh = vehicleRows.find((v) => v.employee_id === e.id);

      let photoUrl: string | null = null;
      if (prof?.photo_key) {
        try {
          photoUrl = storageService.generateSignedUrl({
            file_key: prof.photo_key,
            expires_in_minutes: 180,
          }).signed_url;
        } catch {
          photoUrl = null;
        }
      }

      return {
        id: e.id.toString(),
        user_id: e.user_id.toString(),
        branch_id: e.branch_id.toString(),
        email: e.email,
        name: e.name ?? '',
        lastname_p: e.lastname_p ?? '',
        lastname_m: e.lastname_m ?? null,
        phone: e.phone ?? null,
        role: e.role,
        can_attend: e.can_attend,
        active: e.active,
        profile: {
          photo_key: prof?.photo_key ?? null,
          photo_url: photoUrl,
          bio: prof?.bio ?? null,
        },
        vehicle: veh
          ? {
              id: veh.id.toString(),
              employee_id: veh.employee_id.toString(),
              plate: veh.plate,
              brand: veh.brand,
              model: veh.model,
              color: veh.color,
              active: veh.active,
            }
          : null,
      };
    });
  }

  /**
   * Obtiene el perfil de empleado del usuario que tiene la sesión iniciada.
   */
  async getMyEmployeeProfile(user: AuthenticatedUser): Promise<EmployeeDetailResponse> {
    const [emp] = await db
      .select({ id: employees.UniqueID })
      .from(employees)
      .where(eq(employees.user_id, BigInt(user.id)))
      .limit(1);

    if (!emp) {
      throw new NotFoundError('No tienes una asignación de empleado o técnico activa.');
    }

    return this.getEmployeeDetail(emp.id, user);
  }
}

export const employeeProfileService = new EmployeeProfileService();
