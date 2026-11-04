
import 'dotenv/config';

import {
    createHash,
    createHmac,
    randomInt,
    randomUUID,
    timingSafeEqual
} from 'node:crypto';

import bcrypt from 'bcryptjs';

import { and, eq } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import { ENV } from '../config/env.ts';

import {
    users,
    sessions
} from '../database/schema/tables.ts';

import {
    sendPasswordRecoveryCodeEmail
} from './email.service.ts';

// ============================================================
// CONFIGURACIÓN
// ============================================================

const RECOVERY_SECRET = process.env.PASSWORD_RECOVERY_SECRET;

const CODE_TTL_SECONDS = 600;       // 10 minutos
const RATE_LIMIT_SECONDS = 60;      // 1 minuto
const MAX_CODE_ATTEMPTS = 5;
const PASSWORD_SALT_ROUNDS = 12;

const GENERIC_RECOVERY_MESSAGE =
    'Si el correo está registrado, recibirás instrucciones para recuperar tu contraseña.';

if (!RECOVERY_SECRET || RECOVERY_SECRET.length < 32) {
    throw new Error(
        'PASSWORD_RECOVERY_SECRET debe existir y tener al menos 32 caracteres.'
    );
}

// ============================================================
// ERRORES
// ============================================================

export class PasswordRecoveryError extends Error {
    public statusCode: number;
    public code: string;

    constructor(
        statusCode: number,
        code: string,
        message: string
    ) {
        super(message);

        this.name = 'PasswordRecoveryError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

// ============================================================
// TIPOS
// ============================================================

interface RecoveryRecord {
    userId: string;
    codeHash: string;
}

// ============================================================
// NORMALIZACIÓN Y VALIDACIONES
// ============================================================

function normalizeEmail(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !value.trim()
    ) {
        throw new PasswordRecoveryError(
            400,
            'INVALID_EMAIL',
            'Debes proporcionar un correo electrónico válido.'
        );
    }

    const email = value.trim().toLowerCase();

    if (
        email.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        throw new PasswordRecoveryError(
            400,
            'INVALID_EMAIL',
            'El correo electrónico no es válido.'
        );
    }

    return email;
}

function validateRecoveryCode(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !/^\d{6}$/.test(value)
    ) {
        throw new PasswordRecoveryError(
            400,
            'INVALID_RECOVERY_CODE',
            'El código debe contener exactamente seis dígitos.'
        );
    }

    return value;
}

function validateNewPassword(value: unknown): string {
    if (typeof value !== 'string') {
        throw new PasswordRecoveryError(
            400,
            'INVALID_PASSWORD',
            'Debes proporcionar una nueva contraseña.'
        );
    }

    if (
        value.length < 8 ||
        Buffer.byteLength(value, 'utf8') > 72
    ) {
        throw new PasswordRecoveryError(
            400,
            'INVALID_PASSWORD',
            'La contraseña debe tener al menos 8 caracteres y no superar 72 bytes.'
        );
    }

    return value;
}

// ============================================================
// COMPROBAR REDIS
// ============================================================

function ensureRedisAvailable(): void {
    if (!redis.isReady) {
        throw new PasswordRecoveryError(
            503,
            'RECOVERY_SERVICE_UNAVAILABLE',
            'El servicio de recuperación no está disponible temporalmente.'
        );
    }
}

// ============================================================
// GENERACIÓN DE LLAVES
// ============================================================

function getEmailHash(email: string): string {
    return createHash('sha256')
        .update(email)
        .digest('hex');
}

function getRedisKeys(email: string) {
    const emailHash = getEmailHash(email);

    return {
        recovery: `fixora:password-recovery:${emailHash}`,
        attempts: `fixora:password-recovery:attempts:${emailHash}`,
        rateLimit: `fixora:password-recovery:rate:${emailHash}`,
        lock: `fixora:password-recovery:lock:${emailHash}`
    };
}

// ============================================================
// GENERAR Y COMPARAR CÓDIGOS
// ============================================================

function generateRecoveryCode(): string {
    return randomInt(0, 1_000_000)
        .toString()
        .padStart(6, '0');
}

function generateCodeHash(
    email: string,
    userId: string,
    code: string
): string {
    return createHmac('sha256', RECOVERY_SECRET!)
        .update(`${email}:${userId}:${code}`)
        .digest('hex');
}

function compareCodeHashes(
    receivedHash: string,
    storedHash: string
): boolean {
    const received = Buffer.from(receivedHash, 'hex');
    const stored = Buffer.from(storedHash, 'hex');

    if (
        received.length !== 32 ||
        stored.length !== 32
    ) {
        return false;
    }

    return timingSafeEqual(received, stored);
}

// ============================================================
// VALIDAR REGISTRO ALMACENADO
// ============================================================

function parseRecoveryRecord(
    value: string
): RecoveryRecord {
    let parsed: unknown;

    try {
        parsed = JSON.parse(value);
    } catch {
        throw new PasswordRecoveryError(
            400,
            'INVALID_RECOVERY_CODE',
            'El registro de recuperación no es válido. Solicita un código nuevo.'
        );
    }

    if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('userId' in parsed) ||
        !('codeHash' in parsed)
    ) {
        throw new PasswordRecoveryError(
            400,
            'INVALID_RECOVERY_CODE',
            'El registro de recuperación no es válido. Solicita un código nuevo.'
        );
    }

    const record = parsed as RecoveryRecord;

    if (
        typeof record.userId !== 'string' ||
        !/^[1-9]\d*$/.test(record.userId) ||
        typeof record.codeHash !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(record.codeHash)
    ) {
        throw new PasswordRecoveryError(
            400,
            'INVALID_RECOVERY_CODE',
            'El registro de recuperación no es válido. Solicita un código nuevo.'
        );
    }

    return record;
}

// ============================================================
// LIBERAR BLOQUEO REDIS DE FORMA SEGURA
// ============================================================

async function releaseRecoveryLock(
    lockKey: string,
    lockToken: string
): Promise<void> {
    try {
        await redis.eval(
            `
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end

            return 0
            `,
            {
                keys: [lockKey],
                arguments: [lockToken]
            }
        );
    } catch (error) {
        // No propagar errores al liberar el bloqueo.

    }
}

// ============================================================
// 1. SOLICITAR RECUPERACIÓN DE CONTRASEÑA
// POST /api/auth/forgot-password
// ============================================================

export async function requestPasswordRecovery(
    emailInput: string
) {
    const email = normalizeEmail(emailInput);

    ensureRedisAvailable();

    const keys = getRedisKeys(email);

    // Limitar solicitudes repetidas.
    // La misma respuesta se utiliza para correos registrados
    // y no registrados.

    const rateLimit = await redis.set(
        keys.rateLimit,
        '1',
        {
            EX: RATE_LIMIT_SECONDS,
            NX: true
        }
    );

    if (rateLimit !== 'OK') {
        return {
            message: GENERIC_RECOVERY_MESSAGE
        };
    }

    // Buscar usuario en PostgreSQL.

    const [user] = await db
        .select({
            id: users.UniqueID,
            email: users.email
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

    if (!user) {
        return {
            message: GENERIC_RECOVERY_MESSAGE
        };
    }

    // Generar código.

    const code = generateRecoveryCode();

    const userId = user.id.toString();

    const codeHash = generateCodeHash(
        email,
        userId,
        code
    );

    const recoveryRecord: RecoveryRecord = {
        userId,
        codeHash
    };

    // Guardar código protegido en Redis.
    // Nunca se almacena el código original.

    const saved = await redis.set(
        keys.recovery,
        JSON.stringify(recoveryRecord),
        {
            EX: CODE_TTL_SECONDS
        }
    );

    if (saved !== 'OK') {
        await redis.del(keys.rateLimit);

        throw new PasswordRecoveryError(
            503,
            'RECOVERY_STORAGE_FAILED',
            'No fue posible guardar el código de recuperación.'
        );
    }

    // Reiniciar los intentos del nuevo código.

    await redis.del(keys.attempts);


    // Comprobar configuración del servicio de correo.

    if (
        !ENV.RESEND_API_KEY ||
        !ENV.RESEND_FROM_EMAIL
    ) {
        await redis.del([
            keys.recovery,
            keys.attempts,
            keys.rateLimit
        ]);

        throw new PasswordRecoveryError(
            503,
            'RECOVERY_EMAIL_NOT_CONFIGURED',
            'El servicio de correo de recuperación no está configurado.'
        );
    }

    // Enviar correo utilizando Resend.

    try {
        await sendPasswordRecoveryCodeEmail(
            user.email,
            code,
            CODE_TTL_SECONDS / 60
        );
    } catch (error) {
        await redis.del([
            keys.recovery,
            keys.attempts,
            keys.rateLimit
        ]);


        throw new PasswordRecoveryError(
            503,
            'RECOVERY_EMAIL_FAILED',
            'No fue posible enviar el correo de recuperación. Intenta más tarde.'
        );
    }

    return {
        message: GENERIC_RECOVERY_MESSAGE
    };
}

// ============================================================
// 2. RESTABLECER CONTRASEÑA
// POST /api/auth/reset-password
// ============================================================

export async function resetPassword(
    emailInput: string,
    codeInput: string,
    newPasswordInput: string
) {
    const email = normalizeEmail(emailInput);

    const code = validateRecoveryCode(codeInput);

    const newPassword = validateNewPassword(
        newPasswordInput
    );

    ensureRedisAvailable();

    const keys = getRedisKeys(email);

    // Identificador único del bloqueo.

    const lockToken = randomUUID();

    // Evitar solicitudes simultáneas para el mismo correo.

    const lockAcquired = await redis.set(
        keys.lock,
        lockToken,
        {
            NX: true,
            EX: 30
        }
    );

    if (lockAcquired !== 'OK') {
        throw new PasswordRecoveryError(
            409,
            'RECOVERY_IN_PROGRESS',
            'Ya existe una solicitud de recuperación en proceso.'
        );
    }

    try {
        // ----------------------------------------------------
        // COMPROBAR CONEXIÓN, LLAVE Y EXPIRACIÓN
        // ----------------------------------------------------

        const storedRecord = await redis.get(keys.recovery);

        if (!storedRecord) {
            throw new PasswordRecoveryError(
                400,
                'RECOVERY_CODE_EXPIRED',
                'El código no existe o ha expirado. Solicita uno nuevo.'
            );
        }

        // ----------------------------------------------------
        // INTERPRETAR REGISTRO
        // ----------------------------------------------------

        let recoveryRecord: RecoveryRecord;

        try {
            recoveryRecord = parseRecoveryRecord(
                storedRecord
            );
        } catch (error) {
            await redis.del([
                keys.recovery,
                keys.attempts
            ]);

            throw error;
        }

        // ----------------------------------------------------
        // VERIFICAR INTENTOS
        // ----------------------------------------------------

        const attempts = await redis.incr(keys.attempts);

        if (attempts === 1) {
            await redis.expire(
                keys.attempts,
                CODE_TTL_SECONDS
            );
        }

        if (attempts > MAX_CODE_ATTEMPTS) {
            await redis.del([
                keys.recovery,
                keys.attempts
            ]);

            throw new PasswordRecoveryError(
                429,
                'RECOVERY_ATTEMPTS_EXCEEDED',
                'Se superó el límite de intentos. Solicita un código nuevo.'
            );
        }

        // ----------------------------------------------------
        // VERIFICAR CÓDIGO
        // ----------------------------------------------------

        const receivedHash = generateCodeHash(
            email,
            recoveryRecord.userId,
            code
        );

        const validCode = compareCodeHashes(
            receivedHash,
            recoveryRecord.codeHash
        );

        if (!validCode) {
            if (attempts >= MAX_CODE_ATTEMPTS) {
                await redis.del([
                    keys.recovery,
                    keys.attempts
                ]);

                throw new PasswordRecoveryError(
                    429,
                    'RECOVERY_ATTEMPTS_EXCEEDED',
                    'Se superó el límite de intentos. Solicita un código nuevo.'
                );
            }

            throw new PasswordRecoveryError(
                400,
                'INVALID_RECOVERY_CODE',
                'El código de recuperación es incorrecto.'
            );
        }

        // ----------------------------------------------------
        // CONSULTAR CUENTA
        // ----------------------------------------------------

        const userId = BigInt(
            recoveryRecord.userId
        );

        const [user] = await db
            .select({
                id: users.UniqueID,
                passwordHash: users.password_hash
            })
            .from(users)
            .where(
                and(
                    eq(users.UniqueID, userId),
                    eq(users.email, email)
                )
            )
            .limit(1);

        if (!user) {
            await redis.del([
                keys.recovery,
                keys.attempts
            ]);

            throw new PasswordRecoveryError(
                400,
                'INVALID_RECOVERY_CODE',
                'El código de recuperación ya no es válido.'
            );
        }

        // ----------------------------------------------------
        // EVITAR REUTILIZAR CONTRASEÑA
        // ----------------------------------------------------

        const samePassword = await bcrypt.compare(
            newPassword,
            user.passwordHash
        );

        if (samePassword) {
            throw new PasswordRecoveryError(
                400,
                'PASSWORD_REUSED',
                'La nueva contraseña debe ser diferente a la anterior.'
            );
        }

        // ----------------------------------------------------
        // GENERAR NUEVO HASH
        // ----------------------------------------------------

        const newPasswordHash = await bcrypt.hash(
            newPassword,
            PASSWORD_SALT_ROUNDS
        );

        // ----------------------------------------------------
        // CONSUMIR CÓDIGO
        // ----------------------------------------------------

        // Se consume antes de modificar PostgreSQL para impedir
        // su reutilización. Si falla la transacción, el usuario
        // deberá solicitar un código nuevo.

        await redis.del([
            keys.recovery,
            keys.attempts
        ]);

        // ----------------------------------------------------
        // ACTUALIZAR CONTRASEÑA Y REVOCAR SESIONES
        // ----------------------------------------------------

        await db.transaction(async (tx) => {
            await tx
                .update(users)
                .set({
                    password_hash: newPasswordHash,
                    failed_attempts: 0,
                    locked_until: null
                })
                .where(
                    eq(users.UniqueID, userId)
                );

            await tx
                .update(sessions)
                .set({
                    revoked: true
                })
                .where(
                    and(
                        eq(sessions.user_id, userId),
                        eq(sessions.revoked, false)
                    )
                );
        });

        return {
            message: 'Contraseña restablecida correctamente.'
        };

    } finally {
        await releaseRecoveryLock(
            keys.lock,
            lockToken
        );
    }
}
