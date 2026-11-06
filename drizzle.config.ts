import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || '',
  },
});
