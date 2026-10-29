import 'dotenv/config';

export const ENV = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT) || 3001,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '*',
} as const;
