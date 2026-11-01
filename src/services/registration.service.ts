import 'dotenv/config';

import {
    createHmac,
    randomInt,
    timingSafeEqual,
} from 'node:crypto';

import bcrypt from 'bcryptjs';

import {
    and,
    desc,
    eq,
    isNull,
} from 'drizzle-orm';

import { db } from '../config/database.ts';

import { ENV } from '../config/env.ts';

import {
    email_verification_codes,
    personal_data,
    roles,
    users,
} from '../database/schema/tables.ts';

import { AuthError } from './auth.service.ts';

import { sendVerificationCodeEmail } from './email.service.ts';

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const CODE_TTL_MINUTES =
    ENV.EMAIL_VERIFICATION_CODE_TTL_MINUTES;

const MAX_VERIFICATION_ATTEMPTS =
    ENV.EMAIL_VERIFICATION_MAX_ATTEMPTS;

const RESEND_COOLDOWN_SECONDS =
    ENV.EMAIL_VERIFICATION_RESEND_SECONDS;

// ============================================================================
// TIPOS
// ============================================================================

export interface RegisterClientInput {
    email: string;
    password: string;
    name: string;
    lastname_p: string;
    lastname_m?: string | null;
    birth_date?: string | null;
    phone?: string | null;
}

// ============================================================================
// UTILIDADES
// ============================================================================

function validateConfiguration(): void {
    if (ENV.EMAIL_VERIFICATION_SECRET.length < 32) {
        throw new Error(
            'EMAIL_VERIFICATION_SECRET debe contener al menos 32 caracteres.',
        );
    }

    if (
        !Number.isInteger(CODE_TTL_MINUTES) ||
        CODE_TTL_MINUTES < 1 ||
        !Number.isInteger(MAX_VERIFICATION_ATTEMPTS) ||
        MAX_VERIFICATION_ATTEMPTS < 1 ||
        !Number.isInteger(RESEND_COOLDOWN_SECONDS) ||
        RESEND_COOLDOWN_SECONDS < 1
    ) {
        throw new Error(
            'La configuración de verificación de correo no es válida.',
        );
    }
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function generateVerificationCode(): string {
    return randomInt(0, 1_000_000)
        .toString()
        .padStart(6, '0');
}

function hashVerificationCode(code: string): string {
    validateConfiguration();

    return createHmac(
        'sha256',
        ENV.EMAIL_VERIFICATION_SECRET,
    )
        .update(code)
        .digest('hex');
}

function compareVerificationCode(
    receivedCode: string,
    storedHash: string,
): boolean {
    const receivedHash = hashVerificationCode(receivedCode);

    const receivedBuffer = Buffer.from(receivedHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (receivedBuffer.length !== storedBuffer.length) {
        return false;
    }

    return timingSafeEqual(receivedBuffer, storedBuffer);
}

function validateBirthDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);

    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const databaseError = error as {
        code?: string;
        cause?: unknown;
    };

    if (databaseError.code === '23505') {
        return true;
    }

    return isUniqueViolation(databaseError.cause);
}

function normalizeRegistrationInput(
    input: RegisterClientInput,
): RegisterClientInput {
    // Validar que los campos obligatorios sean cadenas de texto.
    if (
        !input ||
        typeof input.email !== 'string' ||
        typeof input.password !== 'string' ||
        typeof input.name !== 'string' ||
        typeof input.lastname_p !== 'string'
    ) {
        throw new AuthError(
            400,
            'INVALID_INPUT',
            'Debes proporcionar correo, contraseña, nombre y apellido paterno.',
        );
    }

    // Validar los tipos de los campos opcionales.
    const optionalFields = [
        input.lastname_m,
        input.birth_date,
        input.phone,
    ];

    if (
        optionalFields.some(
            (value) =>
                value !== undefined &&
                value !== null &&
                typeof value !== 'string',
        )
    ) {
        throw new AuthError(
            400,
            'INVALID_INPUT',
            'Los apellidos, la fecha de nacimiento y el teléfono deben ser cadenas de texto.',
        );
    }

    // Normalizar los campos de texto.
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    const lastnameP = input.lastname_p.trim();

    const lastnameM = input.lastname_m?.trim() || null;
    const phone = input.phone?.trim() || null;
    const birthDate = input.birth_date?.trim() || null;

    // Validar correo electrónico.
    if (
        email.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        throw new AuthError(
            400,
            'INVALID_EMAIL',
            'El correo electrónico no tiene un formato válido.',
        );
    }

    // Validar contraseña.
    if (
        input.password.length < 8 ||
        Buffer.byteLength(input.password, 'utf8') > 72
    ) {
        throw new AuthError(
            400,
            'INVALID_PASSWORD',
            'La contraseña debe tener al menos 8 caracteres y no superar los 72 bytes.',
        );
    }

    // Validar nombre.
    if (!name || name.length > 100) {
        throw new AuthError(
            400,
            'INVALID_NAME',
            'El nombre es obligatorio y no puede superar los 100 caracteres.',
        );
    }

    // Validar apellido paterno.
    if (!lastnameP || lastnameP.length > 100) {
        throw new AuthError(
            400,
            'INVALID_LASTNAME',
            'El apellido paterno es obligatorio y no puede superar los 100 caracteres.',
        );
    }

    // Validar apellido materno.
    if (lastnameM && lastnameM.length > 100) {
        throw new AuthError(
            400,
            'INVALID_LASTNAME',
            'El apellido materno no puede superar los 100 caracteres.',
        );
    }

    // Validar teléfono.
    if (phone && phone.length > 30) {
        throw new AuthError(
            400,
            'INVALID_PHONE',
            'El teléfono no puede superar los 30 caracteres.',
        );
    }

    // Validar fecha de nacimiento.
    if (birthDate && !validateBirthDate(birthDate)) {
        throw new AuthError(
            400,
            'INVALID_BIRTH_DATE',
            'La fecha de nacimiento debe tener el formato YYYY-MM-DD y ser válida.',
        );
    }

    // Devolver los datos normalizados.
    return {
        email,
        password: input.password,
        name,
        lastname_p: lastnameP,
        lastname_m: lastnameM,
        birth_date: birthDate,
        phone,
    };
}

// ============================================================================
// REGISTRO DE CLIENTE
// ============================================================================

export async function registerClient(input: RegisterClientInput) {
    validateConfiguration();

    const data = normalizeRegistrationInput(input);

    // Comprobar si el correo ya está registrado.
    const existingUser = await db
        .select({
            id: users.UniqueID,
        })
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);

    if (existingUser.length > 0) {
        throw new AuthError(
            409,
            'EMAIL_ALREADY_REGISTERED',
            'Ya existe una cuenta registrada con este correo electrónico.',
        );
    }

    // Obtener el rol cliente.
    const roleResult = await db
        .select({
            id: roles.UniqueID,
        })
        .from(roles)
        .where(
            and(
                eq(roles.name, 'cliente'),
                eq(roles.active, true),
            ),
        )
        .limit(1);

    if (!roleResult[0]) {
        throw new AuthError(
            500,
            'CLIENT_ROLE_NOT_FOUND',
            'No se encuentra disponible el rol cliente.',
        );
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const code = generateVerificationCode();
    const codeHash = hashVerificationCode(code);

    const expiresAt = new Date(
        Date.now() + CODE_TTL_MINUTES * 60 * 1000,
    );

    let userId: bigint;
    let verificationId: bigint;

    // Crear usuario, datos personales y código en una transacción.
    try {
        const created = await db.transaction(async (tx) => {
            const [newUser] = await tx
                .insert(users)
                .values({
                    email: data.email,
                    password_hash: passwordHash,
                    role_id: roleResult[0].id,
                    state: 'por_verificar',
                })
                .returning({
                    id: users.UniqueID,
                });

            if (!newUser) {
                throw new Error('No se pudo crear el usuario.');
            }

            await tx.insert(personal_data).values({
                user_id: newUser.id,
                name: data.name,
                lastname_p: data.lastname_p,
                lastname_m: data.lastname_m,
                birth_date: data.birth_date,
                phone: data.phone,
            });

            const [newCode] = await tx
                .insert(email_verification_codes)
                .values({
                    user_id: newUser.id,
                    code_hash: codeHash,
                    expires_at: expiresAt,
                })
                .returning({
                    id: email_verification_codes.UniqueID,
                });

            if (!newCode) {
                throw new Error(
                    'No se pudo crear el código de verificación.',
                );
            }

            return {
                userId: newUser.id,
                verificationId: newCode.id,
            };
        });

        userId = created.userId;
        verificationId = created.verificationId;
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new AuthError(
                409,
                'EMAIL_ALREADY_REGISTERED',
                'Ya existe una cuenta registrada con este correo electrónico.',
            );
        }

        throw error;
    }

    // El correo se envía después de confirmar la transacción.
    try {
        await sendVerificationCodeEmail(
            data.email,
            data.name,
            code,
        );
    } catch {
        // Eliminar el código que no se pudo enviar.
        await db
            .delete(email_verification_codes)
            .where(
                eq(email_verification_codes.UniqueID, verificationId),
            );

        throw new AuthError(
            503,
            'EMAIL_SEND_FAILED',
            'La cuenta fue creada, pero no fue posible enviar el código. Puedes solicitar otro envío.',
        );
    }

    return {
        message:
            'Registro completado. Revisa tu correo electrónico para verificar tu cuenta.',

        user: {
            id: userId.toString(),
            email: data.email,
            role: 'cliente',
            status: 'por_verificar',
        },

        verification: {
            required: true,
            expiresInMinutes: CODE_TTL_MINUTES,
        },
    };
}

// ============================================================================
// VERIFICACIÓN DEL CORREO
// ============================================================================

type VerificationOutcome =
    | { kind: 'not_found' }
    | { kind: 'already_verified' }
    | { kind: 'no_code' }
    | { kind: 'expired' }
    | { kind: 'attempts_exceeded' }
    | { kind: 'invalid'; attemptsRemaining: number }
    | { kind: 'verified' };

export async function verifyEmail(
    emailInput: string,
    codeInput: string,
) {
    validateConfiguration();

    if (
        typeof emailInput !== 'string' ||
        typeof codeInput !== 'string'
    ) {
        throw new AuthError(
            400,
            'INVALID_INPUT',
            'Debes proporcionar el correo y el código de verificación.',
        );
    }

    const email = normalizeEmail(emailInput);
    const code = codeInput.trim();

    if (!/^\d{6}$/.test(code)) {
        throw new AuthError(
            400,
            'INVALID_CODE_FORMAT',
            'El código debe contener exactamente seis dígitos.',
        );
    }

    const now = new Date();

    /*
     * Se utiliza una transacción con bloqueo de filas para evitar que
     * dos peticiones consuman el mismo código simultáneamente.
     *
     * Los errores se devuelven fuera de la transacción para que los
     * incrementos de intentos y las invalidaciones no se reviertan.
     */

    const outcome = await db.transaction(
        async (tx): Promise<VerificationOutcome> => {
            const [user] = await tx
                .select({
                    id: users.UniqueID,
                    state: users.state,
                })
                .from(users)
                .where(eq(users.email, email))
                .limit(1)
                .for('update');

            if (!user) {
                return { kind: 'not_found' };
            }

            if (user.state === 'activo') {
                return { kind: 'already_verified' };
            }

            if (user.state !== 'por_verificar') {
                return { kind: 'not_found' };
            }

            const [verification] = await tx
                .select({
                    id: email_verification_codes.UniqueID,
                    code_hash: email_verification_codes.code_hash,
                    expires_at: email_verification_codes.expires_at,
                    attempts: email_verification_codes.attempts,
                })
                .from(email_verification_codes)
                .where(
                    and(
                        eq(email_verification_codes.user_id, user.id),
                        isNull(email_verification_codes.used_at),
                    ),
                )
                .orderBy(desc(email_verification_codes.created_at))
                .limit(1)
                .for('update');

            if (!verification) {
                return { kind: 'no_code' };
            }

            if (verification.expires_at <= now) {
                await tx
                    .update(email_verification_codes)
                    .set({ used_at: now })
                    .where(
                        eq(
                            email_verification_codes.UniqueID,
                            verification.id,
                        ),
                    );

                return { kind: 'expired' };
            }

            if (verification.attempts >= MAX_VERIFICATION_ATTEMPTS) {
                await tx
                    .update(email_verification_codes)
                    .set({ used_at: now })
                    .where(
                        eq(
                            email_verification_codes.UniqueID,
                            verification.id,
                        ),
                    );

                return { kind: 'attempts_exceeded' };
            }

            const isValid = compareVerificationCode(
                code,
                verification.code_hash,
            );

            if (!isValid) {
                const nextAttempts = verification.attempts + 1;

                await tx
                    .update(email_verification_codes)
                    .set({
                        attempts: nextAttempts,
                        used_at:
                            nextAttempts >= MAX_VERIFICATION_ATTEMPTS
                                ? now
                                : null,
                    })
                    .where(
                        eq(
                            email_verification_codes.UniqueID,
                            verification.id,
                        ),
                    );

                if (nextAttempts >= MAX_VERIFICATION_ATTEMPTS) {
                    return { kind: 'attempts_exceeded' };
                }

                return {
                    kind: 'invalid',
                    attemptsRemaining:
                        MAX_VERIFICATION_ATTEMPTS - nextAttempts,
                };
            }

            // Consumir el código.
            await tx
                .update(email_verification_codes)
                .set({ used_at: now })
                .where(
                    eq(
                        email_verification_codes.UniqueID,
                        verification.id,
                    ),
                );

            // Activar la cuenta.
            await tx
                .update(users)
                .set({
                    state: 'activo',
                })
                .where(eq(users.UniqueID, user.id));

            return { kind: 'verified' };
        },
    );

    switch (outcome.kind) {
        case 'not_found':
            throw new AuthError(
                400,
                'INVALID_VERIFICATION',
                'No existe una cuenta pendiente de verificación para esos datos.',
            );

        case 'already_verified':
            throw new AuthError(
                409,
                'EMAIL_ALREADY_VERIFIED',
                'El correo electrónico ya fue verificado.',
            );

        case 'no_code':
            throw new AuthError(
                400,
                'VERIFICATION_CODE_NOT_FOUND',
                'No existe un código pendiente. Solicita uno nuevo.',
            );

        case 'expired':
            throw new AuthError(
                400,
                'VERIFICATION_CODE_EXPIRED',
                'El código ha expirado. Solicita uno nuevo.',
            );

        case 'attempts_exceeded':
            throw new AuthError(
                429,
                'VERIFICATION_ATTEMPTS_EXCEEDED',
                'Se alcanzó el máximo de intentos. Solicita un código nuevo.',
            );

        case 'invalid':
            throw new AuthError(
                400,
                'INVALID_VERIFICATION_CODE',
                `El código es incorrecto. Intentos restantes: ${outcome.attemptsRemaining}.`,
            );

        case 'verified':
            return {
                message: 'Correo electrónico verificado correctamente.',
                status: 'activo',
            };
    }
}

// ============================================================================
// REENVÍO DEL CÓDIGO
// ============================================================================

export async function resendVerificationCode(
    emailInput: string,
) {
    validateConfiguration();

    if (typeof emailInput !== 'string' || !emailInput.trim()) {
        throw new AuthError(
            400,
            'INVALID_EMAIL',
            'Debes proporcionar un correo electrónico válido.',
        );
    }

    const email = normalizeEmail(emailInput);

    const [user] = await db
        .select({
            id: users.UniqueID,
            email: users.email,
            state: users.state,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

    // Respuesta genérica para no revelar qué correos están registrados.
    if (!user || user.state !== 'por_verificar') {
        return {
            message:
                'Si existe una cuenta pendiente de verificación, recibirás un correo con las instrucciones.',
        };
    }

    const [lastCode] = await db
        .select({
            created_at: email_verification_codes.created_at,
        })
        .from(email_verification_codes)
        .where(
            eq(email_verification_codes.user_id, user.id),
        )
        .orderBy(desc(email_verification_codes.created_at))
        .limit(1);

    if (lastCode) {
        const secondsSinceLastSend =
            (Date.now() - lastCode.created_at.getTime()) / 1000;

        if (secondsSinceLastSend < RESEND_COOLDOWN_SECONDS) {
            const secondsRemaining = Math.ceil(
                RESEND_COOLDOWN_SECONDS - secondsSinceLastSend,
            );

            throw new AuthError(
                429,
                'RESEND_COOLDOWN',
                `Espera ${secondsRemaining} segundos antes de solicitar otro código.`,
            );
        }
    }

    const code = generateVerificationCode();
    const codeHash = hashVerificationCode(code);

    const expiresAt = new Date(
        Date.now() + CODE_TTL_MINUTES * 60 * 1000,
    );

    // Invalidar el código anterior y generar uno nuevo.
    const [newVerification] = await db.transaction(async (tx) => {
        const now = new Date();

        await tx
            .update(email_verification_codes)
            .set({ used_at: now })
            .where(
                and(
                    eq(email_verification_codes.user_id, user.id),
                    isNull(email_verification_codes.used_at),
                ),
            );

        return tx
            .insert(email_verification_codes)
            .values({
                user_id: user.id,
                code_hash: codeHash,
                expires_at: expiresAt,
            })
            .returning({
                id: email_verification_codes.UniqueID,
            });
    });

    try {
        const [personalData] = await db
            .select({
                name: personal_data.name,
            })
            .from(personal_data)
            .where(eq(personal_data.user_id, user.id))
            .limit(1);

        await sendVerificationCodeEmail(
            user.email,
            personalData?.name ?? 'Cliente',
            code,
        );
    } catch {
        // El código que no se pudo enviar no debe permanecer utilizable.
        await db
            .delete(email_verification_codes)
            .where(
                eq(
                    email_verification_codes.UniqueID,
                    newVerification.id,
                ),
            );

        throw new AuthError(
            503,
            'EMAIL_SEND_FAILED',
            'No fue posible enviar el correo de verificación. Intenta nuevamente.',
        );
    }

    return {
        message: 'Se ha enviado un nuevo código de verificación.',
        verification: {
            expiresInMinutes: CODE_TTL_MINUTES,
            resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
        },
    };
}