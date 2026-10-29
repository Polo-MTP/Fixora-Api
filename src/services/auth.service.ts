import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { SignOptions } from 'jsonwebtoken';

import { db } from '../config/database.ts';
import { roles, sessions, users } from '../database/schema/tables.ts';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';

const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 7);

const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 5);

const LOCK_MINUTES = Number(process.env.LOCK_MINUTES || 15);

if (
  !ACCESS_SECRET ||
  !REFRESH_SECRET ||
  ACCESS_SECRET.length < 32 ||
  REFRESH_SECRET.length < 32 ||
  ACCESS_SECRET === REFRESH_SECRET
) {
  throw new Error('Los secretos JWT deben existir, ser distintos y tener al menos 32 caracteres.');
}

if (
  !Number.isInteger(MAX_LOGIN_ATTEMPTS) ||
  MAX_LOGIN_ATTEMPTS < 1 ||
  !Number.isInteger(LOCK_MINUTES) ||
  LOCK_MINUTES < 1 ||
  !Number.isInteger(REFRESH_TOKEN_DAYS) ||
  REFRESH_TOKEN_DAYS < 1
) {
  throw new Error('La configuración de autenticación no es válida.');
}

const JWT_ISSUER = 'fixora-api';
const JWT_AUDIENCE = 'fixora-client';

export class AuthError extends Error {
  public statusCode: number;
  public code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface AccessTokenPayload {
  sub: string;
  role: string;
  sid: string;
  type: 'access';
}

interface RefreshTokenPayload {
  sub: string;
  sid: string;
  type: 'refresh';
}

interface UserWithRole {
  UniqueID: bigint;
  email: string;
  password_hash: string;
  state: string;
  failed_attempts: number;
  locked_until: Date | null;
  role_name: string;
  role_active: boolean;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Normaliza el estado para admitir valores de enum
 * almacenados en mayúsculas o minúsculas.
 */
function normalizeState(state: string): string {
  return state.trim().toUpperCase();
}

function publicUser(user: { UniqueID: bigint; email: string; state: string; role_name: string }) {
  return {
    id: user.UniqueID.toString(),
    email: user.email,
    role: user.role_name,
    status: user.state,
  };
}

function createAccessToken(userId: string, role: string, sessionId: string): string {
  const payload: AccessTokenPayload = {
    sub: userId,
    role,
    sid: sessionId,
    type: 'access',
  };

  return jwt.sign(payload, ACCESS_SECRET!, {
    expiresIn: ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

function createRefreshToken(userId: string, sessionId: string): string {
  const payload: RefreshTokenPayload = {
    sub: userId,
    sid: sessionId,
    type: 'refresh',
  };

  return jwt.sign(payload, REFRESH_SECRET!, {
    expiresIn: `${REFRESH_TOKEN_DAYS}d`,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

function verifyRefreshToken(refreshToken: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET!, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    if (
      typeof decoded === 'string' ||
      decoded.type !== 'refresh' ||
      typeof decoded.sub !== 'string' ||
      typeof decoded.sid !== 'string'
    ) {
      throw new Error('Token de renovación inválido.');
    }

    return decoded as unknown as RefreshTokenPayload;
  } catch {
    throw new AuthError(
      401,
      'INVALID_REFRESH_TOKEN',
      'El token de renovación no es válido o ha expirado.',
    );
  }
}

function validateActiveAccount(state: string, roleActive: boolean): void {
  if (!roleActive) {
    throw new AuthError(403, 'ROLE_INACTIVE', 'El rol de esta cuenta está desactivado.');
  }

  const normalizedState = normalizeState(state);

  // Aceptar ACTIVO (Drizzle actual) y ACTIVA
  // por compatibilidad con el esquema anterior.
  if (normalizedState !== 'ACTIVO' && normalizedState !== 'ACTIVA') {
    const messages: Record<string, string> = {
      POR_VERIFICAR: 'La cuenta aún está pendiente de verificación.',
      POR_APROBAR: 'La cuenta está pendiente de aprobación.',
      BLOQUEADA: 'La cuenta está bloqueada.',
      SUSPENDIDO: 'La cuenta está suspendida.',
      INACTIVO: 'La cuenta está inactiva.',
    };

    throw new AuthError(
      403,
      'ACCOUNT_NOT_ACTIVE',
      messages[normalizedState] ?? 'La cuenta no está habilitada para iniciar sesión.',
    );
  }
}

async function findUserByEmail(email: string): Promise<UserWithRole | undefined> {
  const result = await db
    .select({
      UniqueID: users.UniqueID,
      email: users.email,
      password_hash: users.password_hash,
      state: users.state,
      failed_attempts: users.failed_attempts,
      locked_until: users.locked_until,
      role_name: roles.name,
      role_active: roles.active,
    })
    .from(users)
    .innerJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(eq(users.email, email))
    .limit(1);

  return result[0] as UserWithRole | undefined;
}

/**
 * Iniciar sesión y crear una sesión persistente.
 */
export async function login(emailInput: string, password: string) {
  if (
    typeof emailInput !== 'string' ||
    typeof password !== 'string' ||
    !emailInput.trim() ||
    !password
  ) {
    throw new AuthError(
      400,
      'INVALID_CREDENTIALS',
      'Debes proporcionar el correo y la contraseña.',
    );
  }

  const email = emailInput.trim().toLowerCase();
  const user = await findUserByEmail(email);

  // No revelar si el correo existe.
  if (!user) {
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
  }

  const now = new Date();

  if (user.locked_until && user.locked_until > now) {
    throw new AuthError(
      423,
      'ACCOUNT_TEMPORARILY_LOCKED',
      'La cuenta está bloqueada temporalmente. Intenta más tarde.',
    );
  }

  // Limpiar un bloqueo temporal que ya expiró.
  if (user.locked_until && user.locked_until <= now) {
    await db
      .update(users)
      .set({
        failed_attempts: 0,
        locked_until: null,
      })
      .where(eq(users.UniqueID, user.UniqueID));

    user.failed_attempts = 0;
    user.locked_until = null;
  }

  const passwordIsValid = await bcrypt.compare(password, user.password_hash);

  if (!passwordIsValid) {
    const failedAttempts = user.failed_attempts + 1;
    const shouldLock = failedAttempts >= MAX_LOGIN_ATTEMPTS;

    await db
      .update(users)
      .set({
        failed_attempts: shouldLock ? 0 : failedAttempts,
        locked_until: shouldLock ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : null,
      })
      .where(eq(users.UniqueID, user.UniqueID));

    if (shouldLock) {
      throw new AuthError(
        423,
        'ACCOUNT_TEMPORARILY_LOCKED',
        `Se alcanzó el límite de intentos. Intenta de nuevo en ${LOCK_MINUTES} minutos.`,
      );
    }

    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
  }

  validateActiveAccount(user.state, user.role_active);

  // Reiniciar los intentos después de autenticar correctamente.
  await db
    .update(users)
    .set({
      failed_attempts: 0,
      locked_until: null,
    })
    .where(eq(users.UniqueID, user.UniqueID));

  const userId = user.UniqueID.toString();
  const sessionId = randomUUID();

  const accessToken = createAccessToken(userId, user.role_name, sessionId);

  const refreshToken = createRefreshToken(userId, sessionId);

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    id: sessionId,
    user_id: user.UniqueID,
    refresh_hash: hashToken(refreshToken),
    expires_at: expiresAt,
  });

  return {
    message: 'Inicio de sesión exitoso.',
    user: publicUser(user),
    tokens: {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL,
    },
  };
}

/**
 * Renovar tokens y revocar el refresh token anterior
 * mediante la rotación de su hash almacenado.
 */
export async function refreshSession(refreshToken: string) {
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new AuthError(
      400,
      'REFRESH_TOKEN_REQUIRED',
      'Debes proporcionar el token de renovación.',
    );
  }

  const payload = verifyRefreshToken(refreshToken);
  const now = new Date();

  const result = await db
    .select({
      session_id: sessions.id,
      session_user_id: sessions.user_id,
      refresh_hash: sessions.refresh_hash,
      expires_at: sessions.expires_at,
      revoked: sessions.revoked,
      UniqueID: users.UniqueID,
      email: users.email,
      state: users.state,
      role_name: roles.name,
      role_active: roles.active,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.user_id, users.UniqueID))
    .innerJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(eq(sessions.id, payload.sid))
    .limit(1);

  const session = result[0];

  if (
    !session ||
    session.revoked ||
    session.expires_at <= now ||
    session.refresh_hash !== hashToken(refreshToken) ||
    session.UniqueID.toString() !== payload.sub
  ) {
    throw new AuthError(401, 'INVALID_SESSION', 'La sesión no es válida o ha expirado.');
  }

  validateActiveAccount(session.state, session.role_active);

  const userId = session.UniqueID.toString();

  const newAccessToken = createAccessToken(userId, session.role_name, session.session_id);

  const newRefreshToken = createRefreshToken(userId, session.session_id);

  const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  // Actualización condicional: impide reutilizar un refresh
  // token si otra petición ya lo rotó o la sesión expiró.
  const updated = await db
    .update(sessions)
    .set({
      refresh_hash: hashToken(newRefreshToken),
      expires_at: newExpiresAt,
    })
    .where(
      and(
        eq(sessions.id, session.session_id),
        eq(sessions.revoked, false),
        eq(sessions.refresh_hash, hashToken(refreshToken)),
        gt(sessions.expires_at, new Date()),
      ),
    )
    .returning({
      id: sessions.id,
    });

  if (updated.length !== 1) {
    throw new AuthError(401, 'INVALID_SESSION', 'La sesión ya fue renovada o dejó de ser válida.');
  }

  return {
    message: 'Sesión renovada correctamente.',
    tokens: {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL,
    },
  };
}

/**
 * Cerrar sesión revocando la sesión asociada al refresh token.
 */
export async function logout(refreshToken: string) {
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new AuthError(
      400,
      'REFRESH_TOKEN_REQUIRED',
      'Debes proporcionar el token de renovación.',
    );
  }

  const payload = verifyRefreshToken(refreshToken);

  await db
    .update(sessions)
    .set({
      revoked: true,
    })
    .where(
      and(
        eq(sessions.id, payload.sid),
        eq(sessions.revoked, false),
        eq(sessions.refresh_hash, hashToken(refreshToken)),
        gt(sessions.expires_at, new Date()),
      ),
    );

  return {
    message: 'Sesión cerrada correctamente.',
  };
}
