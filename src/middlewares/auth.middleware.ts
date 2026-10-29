import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { and, eq, gt } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { roles, sessions, users } from '../database/schema/tables.ts';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

const JWT_ISSUER = 'fixora-api';
const JWT_AUDIENCE = 'fixora-client';

interface AccessTokenPayload {
  sub: string;
  role: string;
  sid: string;
  type: 'access';
}

export interface AuthenticatedUser {
  id: string;
  role: string;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Verificar la configuración de autenticación.
    if (!ACCESS_SECRET || ACCESS_SECRET.length < 32) {
      res.status(500).json({
        error: 'AUTH_CONFIGURATION_ERROR',
        message: 'La autenticación no está configurada correctamente.',
      });
      return;
    }

    // Obtener el token Bearer.
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'TOKEN_REQUIRED',
        message: 'Debes proporcionar un token de acceso.',
      });
      return;
    }

    const token = authorization.slice('Bearer '.length).trim();

    if (!token) {
      res.status(401).json({
        error: 'TOKEN_REQUIRED',
        message: 'Debes proporcionar un token de acceso.',
      });
      return;
    }

    // Validar firma, expiración, emisor y audiencia.
    let payload: AccessTokenPayload;

    try {
      const decoded = jwt.verify(token, ACCESS_SECRET, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });

      if (
        typeof decoded === 'string' ||
        decoded.type !== 'access' ||
        typeof decoded.sub !== 'string' ||
        typeof decoded.role !== 'string' ||
        typeof decoded.sid !== 'string'
      ) {
        throw new Error('Payload inválido');
      }

      payload = decoded as unknown as AccessTokenPayload;
    } catch {
      res.status(401).json({
        error: 'INVALID_ACCESS_TOKEN',
        message: 'El token no es válido o ha expirado.',
      });
      return;
    }

    // Consultar la sesión y el estado actual de usuario y rol.
    const result = await db
      .select({
        sessionId: sessions.id,
        sessionUserId: sessions.user_id,
        expiresAt: sessions.expires_at,
        revoked: sessions.revoked,
        userId: users.UniqueID,
        userState: users.state,
        roleName: roles.name,
        roleActive: roles.active,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.user_id, users.UniqueID))
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(
        and(
          eq(sessions.id, payload.sid),
          eq(sessions.revoked, false),
          gt(sessions.expires_at, new Date()),
        ),
      )
      .limit(1);

    const session = result[0];

    if (!session || session.userId.toString() !== payload.sub) {
      res.status(401).json({
        error: 'INVALID_SESSION',
        message: 'La sesión ya no es válida.',
      });
      return;
    }

    // El estado debe corresponder al enum de la base de datos.
    const accountState = String(session.userState).trim().toUpperCase();

    if (accountState !== 'ACTIVA' || !session.roleActive) {
      res.status(403).json({
        error: 'ACCOUNT_NOT_ACTIVE',
        message: 'La cuenta no está habilitada.',
      });
      return;
    }

    // Se utiliza el rol actual de la base de datos,
    // no el valor del rol incluido en el token.
    req.user = {
      id: session.userId.toString(),
      role: session.roleName,
      sessionId: session.sessionId,
    };

    next();
  } catch (error) {
    next(error);
  }
}
