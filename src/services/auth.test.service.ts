import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { roles, users } from '../database/schema/tables.ts';

export const TEST_ROLES = [
  'administrador',
  'soporte',
  'cliente',
  'proveedor',
  'gerente',
  'empleado',
] as const;

export type TestRole = (typeof TEST_ROLES)[number];

export type TestUserStatus = 'activo' | 'por_verificar' | 'por_aprobar';

export class TestUserError extends Error {
  public statusCode: number;
  public code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'TestUserError';
  }
}

export async function createTestUser(
  emailInput: string,
  password: string,
  roleName: TestRole = 'cliente',
  status: TestUserStatus = 'activo',
) {
  if (process.env.NODE_ENV === 'production') {
    throw new TestUserError(
      403,
      'TEST_USERS_DISABLED',
      'La creación de usuarios de prueba está deshabilitada.',
    );
  }

  if (typeof emailInput !== 'string' || typeof password !== 'string') {
    throw new TestUserError(400, 'INVALID_INPUT', 'El correo y la contraseña son obligatorios.');
  }

  const email = emailInput.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TestUserError(400, 'INVALID_EMAIL', 'El correo electrónico no es válido.');
  }

  if (password.length < 8 || password.length > 72) {
    throw new TestUserError(
      400,
      'INVALID_PASSWORD',
      'La contraseña debe tener entre 8 y 72 caracteres.',
    );
  }

  if (!(TEST_ROLES as readonly string[]).includes(roleName)) {
    throw new TestUserError(400, 'INVALID_ROLE', 'El rol indicado no es válido.');
  }

  const validStatuses: TestUserStatus[] = ['activo', 'por_verificar', 'por_aprobar'];

  if (!validStatuses.includes(status)) {
    throw new TestUserError(400, 'INVALID_STATUS', 'El estado indicado no es válido.');
  }

  // Buscar el rol en PostgreSQL mediante Drizzle.
  const [role] = await db
    .select({
      id: roles.UniqueID,
      name: roles.name,
      active: roles.active,
    })
    .from(roles)
    .where(eq(roles.name, roleName))
    .limit(1);

  if (!role || !role.active) {
    throw new TestUserError(400, 'ROLE_NOT_FOUND', `El rol ${roleName} no existe o está inactivo.`);
  }

  const password_hash = await bcrypt.hash(password, 12);

  try {
    const [user] = await db
      .insert(users)
      .values({
        email,
        password_hash,
        role_id: role.id,
        state: status,
      })
      .returning({
        id: users.UniqueID,
        email: users.email,
        state: users.state,
      });

    if (!user) {
      throw new Error('No fue posible recuperar el usuario creado.');
    }

    return {
      message: 'Usuario de prueba creado correctamente.',
      user: {
        id: user.id.toString(),
        email: user.email,
        role: role.name,
        status: user.state,
      },
    };
  } catch (error: unknown) {
    // PostgreSQL: 23505 = unique_violation.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new TestUserError(
        409,
        'EMAIL_ALREADY_EXISTS',
        'Ya existe un usuario con ese correo electrónico.',
      );
    }

    throw error;
  }
}
