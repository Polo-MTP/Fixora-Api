export type DevicePlatform = 'android' | 'ios' | 'web';

export interface RegisterDeviceTokenInput {
  token: string;
  platform: DevicePlatform;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export interface AlarmNotificationPayload {
  title: string;
  body: string;
  channelId?: string;
  sound?: string;
  data?: Record<string, string>;
  tag?: string;
}

/**
 * Aviso de solicitud entrante (API-28): en Android va solo con datos para que la app arme la
 * alarma a pantalla completa aunque esté cerrada; [ttlSeconds] evita entregarla ya vencida.
 */
export interface IncomingRequestAlarmPayload {
  title: string;
  body: string;
  channelId?: string;
  data?: Record<string, string>;
  ttlSeconds?: number;
}

export interface PushSendResult {
  successCount: number;
  failureCount: number;
  dispatchedTokens: string[];
  invalidTokens: string[];
}
