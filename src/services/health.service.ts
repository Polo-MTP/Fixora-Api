import { sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { ENV } from '../config/env.ts';

export class HealthService {
  async getHealthStatus() {
    let databaseStatus: 'connected' | 'error';

    try {
      await db.execute(sql`SELECT 1`);
      databaseStatus = 'connected';
    } catch {
      databaseStatus = 'error';
    }

    return {
      status: 'ok',
      environment: ENV.NODE_ENV,
      database: databaseStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}

export const healthService = new HealthService();
