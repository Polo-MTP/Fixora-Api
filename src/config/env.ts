import 'dotenv/config';

export const ENV = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT) || 3001,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '*',

  // Resend
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL ?? '',

  // Verificación de correo
  EMAIL_VERIFICATION_SECRET:
    process.env.EMAIL_VERIFICATION_SECRET ?? '',

  EMAIL_VERIFICATION_CODE_TTL_MINUTES:
    Number(process.env.EMAIL_VERIFICATION_CODE_TTL_MINUTES) || 10,

  EMAIL_VERIFICATION_MAX_ATTEMPTS:
    Number(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS) || 5,

  EMAIL_VERIFICATION_RESEND_SECONDS:
    Number(process.env.EMAIL_VERIFICATION_RESEND_SECONDS) || 60,

} as const;
