import 'dotenv/config';

export const ENV = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT) || 3001,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '*',

  // Resend
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL ?? '',

  // Verificación de correo
  EMAIL_VERIFICATION_SECRET: process.env.EMAIL_VERIFICATION_SECRET ?? '',

  EMAIL_VERIFICATION_CODE_TTL_MINUTES:
    Number(process.env.EMAIL_VERIFICATION_CODE_TTL_MINUTES) || 10,

  EMAIL_VERIFICATION_MAX_ATTEMPTS: Number(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS) || 5,

  EMAIL_VERIFICATION_RESEND_SECONDS: Number(process.env.EMAIL_VERIFICATION_RESEND_SECONDS) || 60,

  // Almacenamiento local (tipo Laravel Storage) y enlaces firmados.
  // El secreto es propio de los enlaces: no se reutiliza el de JWT ni hay un valor fijo en código
  // (ver resolveSignSecret en storage.service.ts).
  STORAGE_DIR: process.env.STORAGE_DIR ?? 'storage',
  STORAGE_SIGNED_URL_SECRET: process.env.STORAGE_SIGNED_URL_SECRET ?? '',
  APP_URL: process.env.APP_URL ?? `http://localhost:${Number(process.env.PORT) || 3001}`,

  // Firebase Cloud Messaging (FCM)
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? '',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ?? '',
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '',
} as const;