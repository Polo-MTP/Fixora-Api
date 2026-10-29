import type { Request, Response, NextFunction } from 'express';

import {
  createTestUser,
  TestUserError,
  TEST_ROLES,
  type TestRole,
  type TestUserStatus,
} from '../services/auth.test.service.ts';

const VALID_STATUSES: TestUserStatus[] = ['activo', 'por_verificar', 'por_aprobar'];

export async function createTestUserController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Evitar la creación de usuarios de prueba en producción.
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({
        error: 'TEST_USERS_DISABLED',
        message: 'La creación de usuarios de prueba está deshabilitada.',
      });
      return;
    }

    // Diagnóstico temporal para verificar el cuerpo recibido.
    console.log('Controlador de prueba ejecutado');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Body recibido:', req.body);

    const body = req.body ?? {};
    const { email, password, role, status } = body;

    // Validar los campos obligatorios.
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Debes proporcionar email y password como cadenas de texto no vacías.',
      });
      return;
    }

    // Valores predeterminados.
    const selectedRole: unknown = role ?? 'cliente';
    const selectedStatus: unknown = status ?? 'activo';

    // Validar el rol.
    if (
      typeof selectedRole !== 'string' ||
      !(TEST_ROLES as readonly string[]).includes(selectedRole)
    ) {
      res.status(400).json({
        error: 'INVALID_ROLE',
        message: 'El rol especificado no es válido.',
        availableRoles: TEST_ROLES,
      });
      return;
    }

    // Validar el estado.
    if (
      typeof selectedStatus !== 'string' ||
      !(VALID_STATUSES as readonly string[]).includes(selectedStatus)
    ) {
      res.status(400).json({
        error: 'INVALID_STATUS',
        message: 'El estado especificado no es válido.',
        availableStatuses: VALID_STATUSES,
      });
      return;
    }

    // Crear el usuario mediante el servicio.
    const result = await createTestUser(
      email.trim().toLowerCase(),
      password,
      selectedRole as TestRole,
      selectedStatus as TestUserStatus,
    );

    res.status(201).json(result);
  } catch (error: unknown) {
    // Errores de negocio controlados por el servicio.
    if (error instanceof TestUserError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
      return;
    }

    // Delegar errores inesperados al middleware global.
    next(error);
  }
}
