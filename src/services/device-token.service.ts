import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { device_tokens } from '../database/schema/tables.ts';
import { BadRequestError, NotFoundError } from '../errors/app-error.ts';
import type { DevicePlatform, RegisterDeviceTokenInput } from '../types/device-token.types.ts';

const VALID_PLATFORMS: DevicePlatform[] = ['android', 'ios', 'web'];

export class DeviceTokenService {
  /**
   * Registra un token de dispositivo para un usuario al iniciar sesión.
   * Si el token ya existía (por ejemplo en otro usuario por cambio de dispositivo o reinstalación),
   * se reasigna a este usuario y se activa.
   */
  async registerToken(userId: string | bigint, input: RegisterDeviceTokenInput) {
    if (!input || typeof input.token !== 'string' || !input.token.trim()) {
      throw new BadRequestError('El token del dispositivo es obligatorio y no puede estar vacío.');
    }

    const token = input.token.trim();
    if (token.length > 500) {
      throw new BadRequestError('El token del dispositivo no puede exceder los 500 caracteres.');
    }

    const platform = (input.platform?.toLowerCase() as DevicePlatform) || 'android';
    if (!VALID_PLATFORMS.includes(platform)) {
      throw new BadRequestError(
        `Plataforma no válida ('${input.platform}'). Debe ser android, ios o web.`,
      );
    }

    const userBigInt = BigInt(userId);

    // Verificar si el token ya existe en la base de datos
    const [existing] = await db
      .select({ id: device_tokens.UniqueID, user_id: device_tokens.user_id })
      .from(device_tokens)
      .where(eq(device_tokens.token, token))
      .limit(1);

    if (existing) {
      await db
        .update(device_tokens)
        .set({
          user_id: userBigInt,
          platform,
          active: true,
        })
        .where(eq(device_tokens.UniqueID, existing.id));

      return {
        token,
        platform,
        active: true,
        user_id: userBigInt.toString(),
      };
    }

    await db.insert(device_tokens).values({
      user_id: userBigInt,
      token,
      platform,
      active: true,
    });

    return {
      token,
      platform,
      active: true,
      user_id: userBigInt.toString(),
    };
  }

  /**
   * Desactiva un token de dispositivo para el usuario actual al cerrar sesión.
   * Lanza NotFoundError si el token no pertenece al usuario o no existe.
   */
  async deactivateToken(userId: string | bigint, tokenInput: string) {
    if (!tokenInput || typeof tokenInput !== 'string') {
      throw new BadRequestError('Debes proporcionar el token de dispositivo a desactivar.');
    }

    const token = decodeURIComponent(tokenInput.trim());
    const userBigInt = BigInt(userId);

    const [existing] = await db
      .select({ id: device_tokens.UniqueID, active: device_tokens.active })
      .from(device_tokens)
      .where(and(eq(device_tokens.user_id, userBigInt), eq(device_tokens.token, token)))
      .limit(1);

    if (!existing) {
      throw new NotFoundError('Dispositivo o token no encontrado para este usuario.');
    }

    if (existing.active) {
      await db
        .update(device_tokens)
        .set({ active: false })
        .where(eq(device_tokens.UniqueID, existing.id));
    }

    return {
      token,
      active: false,
      message: 'Token desactivado exitosamente.',
    };
  }

  /**
   * Desactiva un token por su valor (utilizado al cerrar sesión general o por invalidación).
   */
  async deactivateTokenByValue(tokenInput: string) {
    if (!tokenInput || typeof tokenInput !== 'string') {
      return;
    }

    const token = tokenInput.trim();
    await db.update(device_tokens).set({ active: false }).where(eq(device_tokens.token, token));
  }

  /**
   * Obtiene todos los tokens activos de un usuario para el envío de notificaciones push.
   */
  async getActiveTokensForUser(userId: string | bigint) {
    const userBigInt = BigInt(userId);

    const rows = await db
      .select({
        token: device_tokens.token,
        platform: device_tokens.platform,
      })
      .from(device_tokens)
      .where(and(eq(device_tokens.user_id, userBigInt), eq(device_tokens.active, true)));

    return rows;
  }

  /**
   * Desactiva una lista de tokens que FCM reportó como inválidos o desregistrados.
   */
  async deactivateInvalidTokens(tokens: string[]) {
    if (!tokens || tokens.length === 0) {
      return;
    }

    await db
      .update(device_tokens)
      .set({ active: false })
      .where(inArray(device_tokens.token, tokens));
  }
}

export const deviceTokenService = new DeviceTokenService();
