import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ENV } from './env.ts';
import * as schema from '../database/schema/index.ts';

// La sesión trabaja en UTC: así las fechas que pone la base (defaultNow) y las que manda la API
// (new Date()) quedan en la misma zona y se pueden comparar.
const client = postgres(ENV.DATABASE_URL, { connection: { TimeZone: 'UTC' } });

export const db = drizzle(client, { schema });
