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

export interface PushSendResult {
  successCount: number;
  failureCount: number;
  dispatchedTokens: string[];
  invalidTokens: string[];
}
