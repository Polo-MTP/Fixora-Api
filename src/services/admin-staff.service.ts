
import 'dotenv/config';

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

import { db } from '../config/database.ts';

import {
    roles,
    users,
    personal_data
} from '../database/schema/tables.ts';

// ============================================================
// CONFIGURACIÓN
// ============================================================

const ADMIN_PRINCIPAL_EMAIL =
    process.env.ADMIN_PRINCIPAL_EMAIL?.trim().toLowerCase();

const PASSWORD_SALT_ROUNDS = 12;

const AVAILABLE_ROLES = [
    'administrador',
    'soporte'
] as const;

const AVAILABLE_STATUSES = [
    'activo'
] as const;

export type StaffRole = typeof AVAILABLE_ROLES[number];

// ============================================================
// TIPOS
// ============================================================

export interface CreateStaffInput {
    email: string;
    password: string;
    name: string;
    lastname_p: string;
    lastname_m?: string | null;
    role: StaffRole;
    birth_date?: string | null;
    phone?: string | null;
}

interface ValidationDetail {
    field: string;
    message: string;
}

interface ValidatedStaffInput {
    email: string;
    password: string;
    name: string;
    lastname_p: string;
    lastname_m: string | null;
    role: StaffRole;
    birth_date: string | null;
    phone: string | null;
}

// ============================================================
// ERRORES
// ============================================================

export class AdminStaffError extends Error {
    public statusCode: number;
    public code: string;
    public details?: ValidationDetail[];

    constructor(
        statusCode: number,
        code: string,
        message: string,
        details?: ValidationDetail[]
    ) {
        super(message);

        this.name = 'AdminStaffError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}

// ============================================================
// VALIDACIÓN DE FECHA
// ============================================================

function isValidDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);

    const date = new Date(
        Date.UTC(year, month - 1, day)
    );

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day &&
        date.getTime() <= Date.now()
    );
}

// ============================================================
// VALIDAR ENTRADA
// ============================================================

function validateStaffInput(
    input: unknown
): ValidatedStaffInput {
    const details: ValidationDetail[] = [];

    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
    ) {
        throw new AdminStaffError(
            400,
            'VALIDATION_ERROR',
            'Los datos enviados no son válidos.',
            [{
                field: 'body',
                message: 'El cuerpo de la solicitud debe ser un objeto JSON.'
            }]
        );
    }

    const body = input as Record<string, unknown>;

    const allowedFields = [
        'email',
        'password',
        'name',
        'lastname_p',
        'lastname_m',
        'role',
        'birth_date',
        'phone'
    ];

    for (const field of Object.keys(body)) {
        if (!allowedFields.includes(field)) {
            details.push({
                field,
                message: `El campo ${field} no está permitido.`
            });
        }
    }

    // Correo electrónico.
    let email = '';

    if (typeof body.email !== 'string' || !body.email.trim()) {
        details.push({
            field: 'email',
            message: 'El correo electrónico es obligatorio.'
        });
    } else {
        email = body.email.trim().toLowerCase();

        if (
            email.length > 255 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
            details.push({
                field: 'email',
                message: 'El correo electrónico no es válido.'
            });
        }
    }

    // Contraseña.
    let password = '';

    if (
        typeof body.password !== 'string' ||
        !body.password
    ) {
        details.push({
            field: 'password',
            message: 'La contraseña es obligatoria.'
        });
    } else {
        password = body.password;

        if (
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            details.push({
                field: 'password',
                message: 'La contraseña debe tener al menos 8 caracteres y no superar 72 bytes.'
            });
        }
    }

    // Nombre.
    let name = '';

    if (
        typeof body.name !== 'string' ||
        !body.name.trim()
    ) {
        details.push({
            field: 'name',
            message: 'El nombre es obligatorio.'
        });
    } else {
        name = body.name.trim();

        if (name.length > 100) {
            details.push({
                field: 'name',
                message: 'El nombre no puede superar 100 caracteres.'
            });
        }
    }

    // Apellido paterno.
    let lastname_p = '';

    if (
        typeof body.lastname_p !== 'string' ||
        !body.lastname_p.trim()
    ) {
        details.push({
            field: 'lastname_p',
            message: 'El apellido paterno es obligatorio.'
        });
    } else {
        lastname_p = body.lastname_p.trim();

        if (lastname_p.length > 100) {
            details.push({
                field: 'lastname_p',
                message: 'El apellido paterno no puede superar 100 caracteres.'
            });
        }
    }

    // Apellido materno.
    let lastname_m: string | null = null;

    if (body.lastname_m !== undefined && body.lastname_m !== null) {
        if (typeof body.lastname_m !== 'string') {
            details.push({
                field: 'lastname_m',
                message: 'El apellido materno debe ser un texto.'
            });
        } else {
            lastname_m = body.lastname_m.trim() || null;

            if (lastname_m && lastname_m.length > 100) {
                details.push({
                    field: 'lastname_m',
                    message: 'El apellido materno no puede superar 100 caracteres.'
                });
            }
        }
    }

    // Rol.
    let role: StaffRole = 'administrador';

    if (
        typeof body.role !== 'string' ||
        !AVAILABLE_ROLES.includes(
            body.role as StaffRole
        )
    ) {
        details.push({
            field: 'role',
            message: 'El rol debe ser administrador o soporte.'
        });
    } else {
        role = body.role as StaffRole;
    }

    // Fecha de nacimiento opcional.
    let birth_date: string | null = null;

    if (body.birth_date !== undefined && body.birth_date !== null) {
        if (
            typeof body.birth_date !== 'string' ||
            !isValidDate(body.birth_date)
        ) {
            details.push({
                field: 'birth_date',
                message: 'La fecha de nacimiento no es válida. Utiliza YYYY-MM-DD.'
            });
        } else {
            birth_date = body.birth_date;
        }
    }

    // Teléfono opcional, pero si se proporciona debe tener 10 dígitos.
    let phone: string | null = null;

    if (body.phone !== undefined && body.phone !== null) {
        if (typeof body.phone !== 'string') {
            details.push({
                field: 'phone',
                message: 'El teléfono debe ser un texto.'
            });
        } else {
            phone = body.phone.trim();

            if (!/^\d{10}$/.test(phone)) {
                details.push({
                    field: 'phone',
                    message: 'El teléfono debe tener 10 dígitos.'
                });
            }
        }
    }

    if (details.length > 0) {
        throw new AdminStaffError(
            400,
            'VALIDATION_ERROR',
            'Los datos enviados no son válidos.',
            details
        );
    }

    return {
        email,
        password,
        name,
        lastname_p,
        lastname_m,
        role,
        birth_date,
        phone
    };
}

// ============================================================
// COMPROBAR CORREO DUPLICADO
// ============================================================

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const current = error as {
        code?: string;
        cause?: {
            code?: string;
        };
    };

    return (
        current.code === '23505' ||
        current.cause?.code === '23505'
    );
}

// ============================================================
// VERIFICAR ADMINISTRADOR PRINCIPAL
// ============================================================

async function verifyPrincipalAdministrator(
    actorId: bigint
): Promise<void> {
    if (!ADMIN_PRINCIPAL_EMAIL) {
        throw new AdminStaffError(
            500,
            'ADMIN_PRINCIPAL_NOT_CONFIGURED',
            'No se ha configurado el administrador principal.'
        );
    }

    const [actor] = await db
        .select({
            email: users.email,
            state: users.state,
            role: roles.name,
            roleActive: roles.active
        })
        .from(users)
        .innerJoin(
            roles,
            eq(users.role_id, roles.UniqueID)
        )
        .where(eq(users.UniqueID, actorId))
        .limit(1);

    const isPrincipal =
        actor &&
        actor.email.trim().toLowerCase() === ADMIN_PRINCIPAL_EMAIL &&
        actor.role.trim().toLowerCase() === 'administrador' &&
        String(actor.state).trim().toLowerCase() === 'activo' &&
        actor.roleActive;

    if (!isPrincipal) {
        throw new AdminStaffError(
            403,
            'INSUFFICIENT_PERMISSIONS',
            'No tienes permisos para realizar esta acción.'
        );
    }
}

// ============================================================
// CREAR ADMINISTRADOR O SOPORTE
// POST /api/admin/staff
// ============================================================

export async function createStaff(
    actorId: bigint,
    input: unknown
) {
    if (actorId <= 0n) {
        throw new AdminStaffError(
            401,
            'INVALID_ACCESS_TOKEN',
            'El token no es válido o ha expirado.'
        );
    }

    // Verificar que quien realiza la operación
    // sea el administrador principal.
    await verifyPrincipalAdministrator(actorId);

    // Validar los datos recibidos.
    const data = validateStaffInput(input);

    // Comprobar correo existente.
    const [existingUser] = await db
        .select({
            id: users.UniqueID
        })
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);

    if (existingUser) {
        throw new AdminStaffError(
            409,
            'EMAIL_ALREADY_REGISTERED',
            'El correo ya está registrado.'
        );
    }

    // Comprobar que el rol exista y esté activo.
    const [role] = await db
        .select({
            id: roles.UniqueID,
            name: roles.name,
            active: roles.active
        })
        .from(roles)
        .where(eq(roles.name, data.role))
        .limit(1);

    if (!role || !role.active) {
        throw new AdminStaffError(
            400,
            'INVALID_INPUT',
            'El rol solicitado no está disponible.'
        );
    }

    // Generar hash de la contraseña.
    const passwordHash = await bcrypt.hash(
        data.password,
        PASSWORD_SALT_ROUNDS
    );

    try {
        // Crear usuario y datos personales en una transacción.
        const result = await db.transaction(async (tx) => {
            const [createdUser] = await tx
                .insert(users)
                .values({
                    email: data.email,
                    password_hash: passwordHash,
                    role_id: role.id,
                    state: 'activo' as typeof users.$inferInsert.state,
                    failed_attempts: 0,
                    locked_until: null
                })
                .returning({
                    id: users.UniqueID,
                    email: users.email,
                    state: users.state
                });

            const [createdPersonalData] = await tx
                .insert(personal_data)
                .values({
                    user_id: createdUser.id,
                    name: data.name,
                    lastname_p: data.lastname_p,
                    lastname_m: data.lastname_m,
                    birth_date: data.birth_date,
                    phone: data.phone
                })
                .returning({
                    name: personal_data.name,
                    lastname_p: personal_data.lastname_p,
                    lastname_m: personal_data.lastname_m,
                    birth_date: personal_data.birth_date,
                    phone: personal_data.phone
                });

            return {
                id: createdUser.id.toString(),
                email: createdUser.email,
                role: role.name,
                state: createdUser.state,
                name: createdPersonalData.name,
                lastname_p: createdPersonalData.lastname_p,
                lastname_m: createdPersonalData.lastname_m,
                birth_date: createdPersonalData.birth_date,
                phone: createdPersonalData.phone
            };
        });

        return result;
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new AdminStaffError(
                409,
                'EMAIL_ALREADY_REGISTERED',
                'El correo ya está registrado.'
            );
        }

        throw error;
    }
}
