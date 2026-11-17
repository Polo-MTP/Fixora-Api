import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, pgClient } from '../../config/database.ts';
import { device_tokens, users } from '../../database/schema/tables.ts';
import { inArray } from 'drizzle-orm';
import { deviceTokenService } from '../device-token.service.ts';
import { FcmService, type MessagingClient } from '../fcm.service.ts';
import { BadRequestError, NotFoundError } from '../../errors/app-error.ts';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';

describe('Integración con Firebase Cloud Messaging y tokens de dispositivo (API-16)', () => {
  let testUserId = 1n;
  let secondUserId = 2n;
  const testToken1 = 'fcm_token_unit_test_alpha_1111';
  const testToken2 = 'fcm_token_unit_test_beta_2222';
  const testToken3 = 'fcm_token_unit_test_gamma_3333';

  before(async () => {
    // Obtener usuarios reales existentes en la base de datos para respetar foreign key
    const existingUsers = await db.select({ id: users.UniqueID }).from(users).limit(2);

    if (existingUsers.length >= 1) {
      testUserId = existingUsers[0].id;
    }
    if (existingUsers.length >= 2) {
      secondUserId = existingUsers[1].id;
    }
  });

  beforeEach(async () => {
    // Limpiar tokens de prueba previos
    try {
      await db
        .delete(device_tokens)
        .where(inArray(device_tokens.token, [testToken1, testToken2, testToken3]));
    } catch {
      // Ignorar si no existen
    }
  });

  after(async () => {
    // Limpieza final de tokens y desconexión limpia de BD
    try {
      await db
        .delete(device_tokens)
        .where(inArray(device_tokens.token, [testToken1, testToken2, testToken3]));
    } catch {
      // Ignorar
    }
    await pgClient.end({ timeout: 1 });
  });

  describe('DeviceTokenService - Validaciones y persistencia', () => {
    it('debe rechazar tokens vacíos o no válidos con BadRequestError', async () => {
      await assert.rejects(
        () => deviceTokenService.registerToken(testUserId, { token: '', platform: 'android' }),
        BadRequestError,
      );

      await assert.rejects(
        () =>
          deviceTokenService.registerToken(testUserId, {
            token: '   ',
            platform: 'android',
          }),
        BadRequestError,
      );
    });

    it('debe rechazar plataformas no soportadas con BadRequestError', async () => {
      await assert.rejects(
        () =>
          deviceTokenService.registerToken(testUserId, {
            token: testToken1,
            // @ts-expect-error probando valor inválido
            platform: 'windows_phone',
          }),
        BadRequestError,
      );
    });

    it('debe rechazar tokens que excedan los 500 caracteres', async () => {
      const longToken = 'a'.repeat(501);
      await assert.rejects(
        () =>
          deviceTokenService.registerToken(testUserId, {
            token: longToken,
            platform: 'android',
          }),
        BadRequestError,
      );
    });

    it('debe registrar un token nuevo exitosamente y activarlo', async () => {
      const result = await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'android',
      });

      assert.equal(result.token, testToken1);
      assert.equal(result.platform, 'android');
      assert.equal(result.active, true);
      assert.equal(result.user_id, testUserId.toString());

      const activeTokens = await deviceTokenService.getActiveTokensForUser(testUserId);
      assert.equal(activeTokens.length, 1);
      assert.equal(activeTokens[0].token, testToken1);
      assert.equal(activeTokens[0].platform, 'android');
    });

    it('debe reasignar y reactivar el token si ya existía en otro usuario', async () => {
      // Primero se registra para el usuario 1
      await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'ios',
      });

      // Se desactiva para el usuario 1
      await deviceTokenService.deactivateToken(testUserId, testToken1);

      // Ahora el usuario 2 inicia sesión en ese mismo dispositivo
      const reassignResult = await deviceTokenService.registerToken(secondUserId, {
        token: testToken1,
        platform: 'ios',
      });

      assert.equal(reassignResult.user_id, secondUserId.toString());
      assert.equal(reassignResult.active, true);

      // El usuario 1 ya no debe tener tokens activos para este token
      const user1Tokens = await deviceTokenService.getActiveTokensForUser(testUserId);
      assert.equal(
        user1Tokens.some((t) => t.token === testToken1),
        false,
      );

      // El usuario 2 debe tener el token activo
      const user2Tokens = await deviceTokenService.getActiveTokensForUser(secondUserId);
      assert.equal(
        user2Tokens.some((t) => t.token === testToken1),
        true,
      );
    });

    it('debe desactivar el token al cerrar sesión (deactivateToken)', async () => {
      await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'android',
      });

      const deactResult = await deviceTokenService.deactivateToken(testUserId, testToken1);
      assert.equal(deactResult.active, false);

      const activeTokens = await deviceTokenService.getActiveTokensForUser(testUserId);
      assert.equal(
        activeTokens.some((t) => t.token === testToken1),
        false,
      );
    });

    it('debe lanzar NotFoundError al desactivar un token no perteneciente al usuario', async () => {
      await assert.rejects(
        () =>
          deviceTokenService.deactivateToken(testUserId, 'token_que_no_existe_para_este_usuario'),
        NotFoundError,
      );
    });

    it('debe desactivar un token por valor con deactivateTokenByValue', async () => {
      await deviceTokenService.registerToken(testUserId, {
        token: testToken2,
        platform: 'web',
      });

      await deviceTokenService.deactivateTokenByValue(testToken2);

      const active = await deviceTokenService.getActiveTokensForUser(testUserId);
      assert.equal(
        active.some((t) => t.token === testToken2),
        false,
      );
    });

    it('debe desactivar un lote de tokens inválidos con deactivateInvalidTokens', async () => {
      await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'android',
      });
      await deviceTokenService.registerToken(testUserId, {
        token: testToken2,
        platform: 'ios',
      });

      await deviceTokenService.deactivateInvalidTokens([testToken1, testToken2]);

      const active = await deviceTokenService.getActiveTokensForUser(testUserId);
      assert.equal(
        active.some((t) => [testToken1, testToken2].includes(t.token)),
        false,
      );
    });
  });

  describe('FcmService - Notificaciones push y alarmas de alta prioridad', () => {
    it('debe retornar éxito vacío si el usuario no tiene tokens activos', async () => {
      const fcm = new FcmService();
      const result = await fcm.sendToUser(888888n, {
        title: 'Hola',
        body: 'Mundo',
      });

      assert.equal(result.successCount, 0);
      assert.equal(result.failureCount, 0);
      assert.equal(result.dispatchedTokens.length, 0);
    });

    it('debe enviar push estándar en modo simulado cuando no hay credenciales', async () => {
      const fcm = new FcmService();
      await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'android',
      });

      const result = await fcm.sendToUser(testUserId, {
        title: 'Servicio en camino',
        body: 'El técnico llegará en 15 minutos.',
      });

      assert.equal(result.successCount, 1);
      assert.equal(result.failureCount, 0);
      assert.deepEqual(result.dispatchedTokens, [testToken1]);
    });

    it('debe despachar alarmas de alta prioridad con la estructura correcta para Android, iOS y Web', async () => {
      const fcm = new FcmService();
      let capturedMessage: MulticastMessage | null = null;

      const mockClient: MessagingClient = {
        async sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse> {
          capturedMessage = message;
          return {
            successCount: message.tokens.length,
            failureCount: 0,
            responses: message.tokens.map(() => ({
              success: true,
              messageId: 'mock-msg-id-123',
            })),
          };
        },
      };

      fcm.setMessagingClient(mockClient);

      await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'android',
      });
      await deviceTokenService.registerToken(testUserId, {
        token: testToken2,
        platform: 'ios',
      });

      const result = await fcm.sendHighPriorityAlarm(testUserId, {
        title: '¡ALERTA DE SEGURIDAD!',
        body: 'Se activó el sensor de fuga de gas en el local Matriz.',
        channelId: 'safety_alarms',
        sound: 'siren_loud',
        data: {
          incident_id: '99',
        },
      });

      assert.equal(result.successCount, 2);
      assert.equal(result.failureCount, 0);
      assert.ok(capturedMessage !== null);

      const msg = capturedMessage as unknown as MulticastMessage;
      assert.equal(msg.tokens.length, 2);

      // Verificación de configuración de prioridad para Android
      assert.equal(msg.android?.priority, 'high');
      assert.equal(msg.android?.notification?.channelId, 'safety_alarms');
      assert.equal(msg.android?.notification?.sound, 'siren_loud');
      assert.equal(msg.android?.notification?.priority, 'max');
      assert.equal(msg.android?.notification?.visibility, 'public');
      assert.deepEqual(
        msg.android?.notification?.vibrateTimingsMillis,
        [0, 500, 200, 500, 200, 1000],
      );

      // Verificación de configuración de prioridad para iOS (APNs)
      assert.equal(msg.apns?.headers?.['apns-priority'], '10');
      assert.equal(msg.apns?.headers?.['apns-push-type'], 'alert');
      const aps = msg.apns?.payload?.aps as Record<string, unknown>;
      assert.equal(aps?.contentAvailable, true);
      const soundObj = aps?.sound as { critical: boolean; name: string; volume: number };
      assert.equal(soundObj?.critical, true);
      assert.equal(soundObj?.name, 'siren_loud.caf');

      // Verificación de Webpush
      assert.equal(msg.webpush?.headers?.Urgency, 'high');

      // Verificación de metadatos de alarma
      assert.equal(msg.data?.is_alarm, 'true');
      assert.equal(msg.data?.alarm_level, 'high');
      assert.equal(msg.data?.incident_id, '99');
      assert.equal(msg.data?.channel_id, 'safety_alarms');
    });

    it('debe limpiar y desactivar tokens inválidos cuando FCM reporta que ya no están registrados', async () => {
      const fcm = new FcmService();

      const mockClient: MessagingClient = {
        async sendEachForMulticast(_message: MulticastMessage): Promise<BatchResponse> {
          return {
            successCount: 1,
            failureCount: 1,
            responses: [
              {
                success: true,
                messageId: 'msg-ok',
              },
              {
                success: false,
                error: {
                  code: 'messaging/registration-token-not-registered',
                  message: 'The registration token is not registered.',
                  name: 'FirebaseError',
                  hasCode: () => true,
                  toJSON: () => ({}),
                },
              },
            ],
          };
        },
      };

      fcm.setMessagingClient(mockClient);

      await deviceTokenService.registerToken(testUserId, {
        token: testToken1,
        platform: 'android',
      });
      await deviceTokenService.registerToken(testUserId, {
        token: testToken2,
        platform: 'ios',
      });

      const result = await fcm.sendToUser(testUserId, {
        title: 'Notificación',
        body: 'Texto',
      });

      assert.equal(result.successCount, 1);
      assert.equal(result.failureCount, 1);
      assert.deepEqual(result.invalidTokens, [testToken2]);

      // Verificar que testToken2 fue desactivado en la BD
      const remainingActive = await deviceTokenService.getActiveTokensForUser(testUserId);
      assert.equal(
        remainingActive.some((t) => t.token === testToken1),
        true,
      );
      assert.equal(
        remainingActive.some((t) => t.token === testToken2),
        false,
      );
    });
  });
});
