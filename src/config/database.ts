import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ENV } from './env.ts';
import * as schema from '../database/schema/index.ts';

const client = postgres(ENV.DATABASE_URL);

export const db = drizzle(client, { schema });
