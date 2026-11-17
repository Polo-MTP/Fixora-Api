import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
    branches,
    business_supplier,
    employees,
    personal_data,
    roles,
    suppliers,
    users,
} from '../database/schema/tables.ts';

const PASSWORD_SALT_ROUNDS = 12;
const EMPLOYEE_ROLES = ['gerente', 'empleado'] as const;

type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

interface ValidationDetail {
    field: string;
    message: string;
}

interface ValidatedEmployeeInput {
    email: string;
    password: string;
    name: string;
    lastname_p: string;
    lastname_m: string | null;
    phone: string | null;
    role: EmployeeRole;
}

export class BranchEmployeeError extends Error {
    public statusCode: number;
    public code: string;
    public details?: ValidationDetail[];

    constructor(statusCode: number, code: string, message: string, details?: ValidationDetail[]) {
        super(message);
        this.name = 'BranchEmployeeError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}

function validateEmployeeInput(input: unknown): ValidatedEmployeeInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new BranchEmployeeError(400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos.', [
            { field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' },
        ]);
    }

    const body = input as Record<string, unknown>;
    const details: ValidationDetail[] = [];
    const allowedFields = ['email', 'password', 'name', 'lastname_p', 'lastname_m', 'phone', 'role'];

    for (const field of Object.keys(body)) {
        if (!allowedFields.includes(field)) {
            details.push({ field, message: `El campo ${field} no está permitido.` });
        }
    }

    let email = '';
    if (typeof body.email !== 'string' || !body.email.trim()) {
        details.push({ field: 'email', message: 'El correo electrónico es obligatorio.' });
    } else {
        email = body.email.trim().toLowerCase();
        if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            details.push({ field: 'email', message: 'El correo electrónico no es válido.' });
        }
    }

    let password = '';
    if (typeof body.password !== 'string' || !body.password) {
        details.push({ field: 'password', message: 'La contraseña es obligatoria.' });
    } else {
        password = body.password;
        if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
            details.push({
                field: 'password',
                message: 'La contraseña debe tener al menos 8 caracteres y no superar 72 bytes.',
            });
        }
    }

    let name = '';
    if (typeof body.name !== 'string' || !body.name.trim()) {
        details.push({ field: 'name', message: 'El nombre es obligatorio.' });
    } else {
        name = body.name.trim();
        if (name.length > 100) {
            details.push({ field: 'name', message: 'El nombre no puede superar 100 caracteres.' });
        }
    }

    let lastname_p = '';
    if (typeof body.lastname_p !== 'string' || !body.lastname_p.trim()) {
        details.push({ field: 'lastname_p', message: 'El apellido paterno es obligatorio.' });
    } else {
        lastname_p = body.lastname_p.trim();
        if (lastname_p.length > 100) {
            details.push({
                field: 'lastname_p',
                message: 'El apellido paterno no puede superar 100 caracteres.',
            });
        }
    }

    let lastname_m: string | null = null;
    if (body.lastname_m !== undefined && body.lastname_m !== null) {
        if (typeof body.lastname_m !== 'string') {
            details.push({ field: 'lastname_m', message: 'El apellido materno debe ser un texto.' });
        } else {
            lastname_m = body.lastname_m.trim() || null;
            if (lastname_m && lastname_m.length > 100) {
                details.push({
                    field: 'lastname_m',
                    message: 'El apellido materno no puede superar 100 caracteres.',
                });
            }
        }
    }

    let phone: string | null = null;
    if (body.phone !== undefined && body.phone !== null) {
        if (typeof body.phone !== 'string') {
            details.push({ field: 'phone', message: 'El teléfono debe ser un texto.' });
        } else {
            phone = body.phone.trim();
            if (!/^\d{10}$/.test(phone)) {
                details.push({ field: 'phone', message: 'El teléfono debe tener 10 dígitos.' });
            }
        }
    }

    let role: EmployeeRole = 'empleado';
    if (typeof body.role !== 'string' || !EMPLOYEE_ROLES.includes(body.role as EmployeeRole)) {
        details.push({ field: 'role', message: 'El rol debe ser gerente o empleado.' });
    } else {
        role = body.role as EmployeeRole;
    }

    if (details.length > 0) {
        throw new BranchEmployeeError(
            400,
            'VALIDATION_ERROR',
            'Los datos enviados no son válidos.',
            details,
        );
    }

    return { email, password, name, lastname_p, lastname_m, phone, role };
}

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const current = error as { code?: string; cause?: { code?: string } };
    return current.code === '23505' || current.cause?.code === '23505';
}

async function ensureBranchExists(branchId: bigint): Promise<void> {
    const [branch] = await db
        .select({ id: branches.UniqueID })
        .from(branches)
        .where(eq(branches.UniqueID, branchId))
        .limit(1);

    if (!branch) {
        throw new BranchEmployeeError(404, 'NOT_FOUND', 'Recurso no encontrado.');
    }
}

async function isBranchOwnedBySupplier(branchId: bigint, userId: bigint): Promise<boolean> {
    const [ownership] = await db
        .select({ branchId: branches.UniqueID })
        .from(branches)
        .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
        .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
        .where(
            and(
                eq(branches.UniqueID, branchId),
                eq(business_supplier.active, true),
                eq(suppliers.active, true),
                eq(suppliers.user_id, userId),
            ),
        )
        .limit(1);

    return Boolean(ownership);
}

async function isManagerOfBranch(branchId: bigint, userId: bigint): Promise<boolean> {
    const [assignment] = await db
        .select({ employeeId: employees.UniqueID })
        .from(employees)
        .innerJoin(users, eq(employees.user_id, users.UniqueID))
        .innerJoin(roles, eq(users.role_id, roles.UniqueID))
        .where(
            and(
                eq(employees.branch_id, branchId),
                eq(employees.user_id, userId),
                eq(employees.active, true),
                eq(roles.name, 'gerente'),
                eq(roles.active, true),
            ),
        )
        .limit(1);

    return Boolean(assignment);
}

export async function listBranchEmployees(branchId: bigint, actorId: bigint, actorRole: string) {
    await ensureBranchExists(branchId);

    const normalizedRole = actorRole.trim().toLowerCase();
    let allowed = false;

    if (normalizedRole === 'proveedor') {
        allowed = await isBranchOwnedBySupplier(branchId, actorId);
    } else if (normalizedRole === 'gerente') {
        allowed = await isManagerOfBranch(branchId, actorId);
    }

    if (!allowed) {
        // Evita revelar si una sucursal pertenece a otro proveedor.
        throw new BranchEmployeeError(404, 'NOT_FOUND', 'Recurso no encontrado.');
    }

    return db
        .select({
            id: employees.UniqueID,
            user_id: users.UniqueID,
            branch_id: employees.branch_id,
            email: users.email,
            name: personal_data.name,
            lastname_p: personal_data.lastname_p,
            role: roles.name,
            can_attend: employees.can_attend,
            active: employees.active,
        })
        .from(employees)
        .innerJoin(users, eq(employees.user_id, users.UniqueID))
        .innerJoin(roles, eq(users.role_id, roles.UniqueID))
        .innerJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
        .where(and(eq(employees.branch_id, branchId), eq(employees.active, true)))
        .orderBy(employees.UniqueID)
        .then((rows) =>
            rows.map((row) => ({
                id: row.id.toString(),
                user_id: row.user_id.toString(),
                branch_id: row.branch_id.toString(),
                email: row.email,
                name: row.name,
                lastname_p: row.lastname_p,
                role: row.role,
                can_attend: row.can_attend,
                active: row.active,
            })),
        );
}

export async function createBranchEmployee(
    branchId: bigint,
    actorId: bigint,
    actorRole: string,
    input: unknown,
) {
    await ensureBranchExists(branchId);

    if (actorRole.trim().toLowerCase() !== 'proveedor') {
        throw new BranchEmployeeError(
            403,
            'INSUFFICIENT_PERMISSIONS',
            'No tienes permisos para realizar esta acción.',
        );
    }

    const ownsBranch = await isBranchOwnedBySupplier(branchId, actorId);
    if (!ownsBranch) {
        throw new BranchEmployeeError(404, 'NOT_FOUND', 'Recurso no encontrado.');
    }

    const data = validateEmployeeInput(input);

    const [existingUser] = await db
        .select({ id: users.UniqueID })
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);

    if (existingUser) {
        throw new BranchEmployeeError(409, 'EMAIL_ALREADY_REGISTERED', 'El correo ya está registrado.');
    }

    const [employeeRole] = await db
        .select({ id: roles.UniqueID, name: roles.name, active: roles.active })
        .from(roles)
        .where(eq(roles.name, data.role))
        .limit(1);

    if (!employeeRole || !employeeRole.active) {
        throw new BranchEmployeeError(400, 'INVALID_INPUT', 'El rol solicitado no está disponible.');
    }

    const passwordHash = await bcrypt.hash(data.password, PASSWORD_SALT_ROUNDS);

    try {
        return await db.transaction(async (tx) => {
            const [createdUser] = await tx
                .insert(users)
                .values({
                    email: data.email,
                    password_hash: passwordHash,
                    role_id: employeeRole.id,
                    state: 'activo',
                    failed_attempts: 0,
                    locked_until: null,
                })
                .returning({ id: users.UniqueID, email: users.email });

            await tx.insert(personal_data).values({
                user_id: createdUser.id,
                name: data.name,
                lastname_p: data.lastname_p,
                lastname_m: data.lastname_m,
                phone: data.phone,
            });

            const [createdEmployee] = await tx
                .insert(employees)
                .values({
                    user_id: createdUser.id,
                    branch_id: branchId,
                    can_attend: true,
                    active: true,
                })
                .returning({
                    id: employees.UniqueID,
                    user_id: employees.user_id,
                    branch_id: employees.branch_id,
                    can_attend: employees.can_attend,
                    active: employees.active,
                });

            return {
                id: createdEmployee.id.toString(),
                user_id: createdEmployee.user_id.toString(),
                branch_id: createdEmployee.branch_id.toString(),
                email: createdUser.email,
                name: data.name,
                lastname_p: data.lastname_p,
                role: employeeRole.name,
                can_attend: createdEmployee.can_attend,
                active: createdEmployee.active,
            };
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new BranchEmployeeError(
                409,
                'EMAIL_ALREADY_REGISTERED',
                'El correo ya está registrado.',
            );
        }
        throw error;
    }
}
