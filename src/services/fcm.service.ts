import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage, type BatchResponse } from 'firebase-admin/messaging';
import { ENV } from '../config/env.ts';
import { deviceTokenService } from './device-token.service.ts';
import type {
  PushNotificationPayload,
  AlarmNotificationPayload,
  PushSendResult,
} from '../types/device-token.types.ts';

export interface MessagingClient {
  sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
}

export class FcmService {
  private app: App | null = null;
  private messagingClient: MessagingClient | null = null;
  private readonly isSimulated: boolean;

  constructor() {
    const hasCredentials = Boolean(
      ENV.FIREBASE_PROJECT_ID && ENV.FIREBASE_CLIENT_EMAIL && ENV.FIREBASE_PRIVATE_KEY,
    );

    if (hasCredentials) {
      try {
        const apps = getApps();
        if (apps.length > 0) {
          this.app = apps[0];
        } else {
          this.app = initializeApp({
            credential: cert({
              projectId: ENV.FIREBASE_PROJECT_ID,
              clientEmail: ENV.FIREBASE_CLIENT_EMAIL,
              privateKey: ENV.FIREBASE_PRIVATE_KEY,
            }),
          });
        }
        this.messagingClient = getMessaging(this.app);
        this.isSimulated = false;
      } catch (error) {
        console.warn(
          '[FcmService] Error al inicializar Firebase Admin SDK. Se ejecutará en modo simulado:',
          error,
        );
        this.isSimulated = true;
      }
    } else {
      // Modo de simulación / desarrollo local sin credenciales
      this.isSimulated = true;
    }
  }

  /**
   * Permite inyectar un cliente de mensajería simulado para pruebas unitarias.
   */
  public setMessagingClient(client: MessagingClient | null): void {
    this.messagingClient = client;
  }

  /**
   * Indica si el servicio está corriendo con Firebase configurado o en simulación.
   */
  public isSimulatedMode(): boolean {
    return this.isSimulated && !this.messagingClient;
  }

  /**
   * Envía una notificación push estándar a todos los dispositivos activos de un usuario.
   */
  public async sendToUser(
    userId: string | bigint,
    payload: PushNotificationPayload,
  ): Promise<PushSendResult> {
    const activeTokens = await deviceTokenService.getActiveTokensForUser(userId);
    if (activeTokens.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        dispatchedTokens: [],
        invalidTokens: [],
      };
    }

    const tokens = activeTokens.map((t) => t.token);
    const message: MulticastMessage = {
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.imageUrl,
      },
      data: payload.data ?? {},
    };

    return this.sendMulticast(message);
  }

  /**
   * Envía una notificación de ALTA PRIORIDAD para emergencias y alarmas críticas.
   * Configura canales de sonido de emergencia, máxima visibilidad y wake-lock en Android e iOS (APNs).
   */
  public async sendHighPriorityAlarm(
    userId: string | bigint,
    payload: AlarmNotificationPayload,
  ): Promise<PushSendResult> {
    const activeTokens = await deviceTokenService.getActiveTokensForUser(userId);
    if (activeTokens.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        dispatchedTokens: [],
        invalidTokens: [],
      };
    }

    const tokens = activeTokens.map((t) => t.token);
    const channelId = payload.channelId ?? 'emergency_alarms';
    const sound = payload.sound ?? 'alarm_high_priority';

    const message: MulticastMessage = {
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: {
        is_alarm: 'true',
        alarm_level: 'high',
        channel_id: channelId,
        timestamp: new Date().toISOString(),
        ...(payload.data ?? {}),
      },
      android: {
        priority: 'high',
        notification: {
          channelId,
          sound,
          priority: 'max',
          visibility: 'public',
          defaultVibrateTimings: false,
          vibrateTimingsMillis: [0, 500, 200, 500, 200, 1000],
          tag: payload.tag ?? 'alarm',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            sound: {
              critical: true,
              name: payload.sound ? `${payload.sound}.caf` : 'alarm.caf',
              volume: 1.0,
            },
            contentAvailable: true,
          },
        },
      },
      webpush: {
        headers: {
          Urgency: 'high',
        },
        notification: {
          requireInteraction: true,
          tag: payload.tag ?? 'alarm',
        },
      },
    };

    return this.sendMulticast(message);
  }

  /**
   * Envía un mensaje multicast a través de Firebase Messaging o simulación local.
   * Invalida automáticamente los tokens reportados como caducados o no registrados.
   */
  public async sendMulticast(message: MulticastMessage): Promise<PushSendResult> {
    if (!message.tokens || message.tokens.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        dispatchedTokens: [],
        invalidTokens: [],
      };
    }

    // Si no hay cliente activo o estamos en modo simulación (entorno de desarrollo/test sin credenciales)
    if (!this.messagingClient) {
      return {
        successCount: message.tokens.length,
        failureCount: 0,
        dispatchedTokens: [...message.tokens],
        invalidTokens: [],
      };
    }

    try {
      const response = await this.messagingClient.sendEachForMulticast(message);
      const invalidTokens: string[] = [];

      response.responses.forEach((resp, index) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(message.tokens[index]);
          }
        }
      });

      // Limpieza automática en la base de datos de tokens inválidos
      if (invalidTokens.length > 0) {
        await deviceTokenService.deactivateInvalidTokens(invalidTokens);
      }

      return {
        successCount: response.successCount,
        failureCount: response.failureCount,
        dispatchedTokens: [...message.tokens],
        invalidTokens,
      };
    } catch (error) {
      console.error('[FcmService] Error inesperado al despachar notificaciones FCM:', error);
      return {
        successCount: 0,
        failureCount: message.tokens.length,
        dispatchedTokens: [...message.tokens],
        invalidTokens: [],
      };
    }
  }
}

export const fcmService = new FcmService();
