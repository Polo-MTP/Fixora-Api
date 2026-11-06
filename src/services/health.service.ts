import { sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { ENV } from '../config/env.ts';
import { redis } from '../config/redis.ts';

export class HealthService {
  async getHealthStatus() {
    let databaseStatus: 'connected' | 'error';

    try {
      await db.execute(sql`SELECT 1`);
      databaseStatus = 'connected';
    } catch {
      databaseStatus = 'error';
    }

    let redisStatus: 'connected' | 'error';

    try {
      await redis.ping();
      redisStatus = 'connected';
    } catch {
      redisStatus = 'error';
    }

    return {
      status: 'ok',
      environment: ENV.NODE_ENV,
      database: databaseStatus,
      redis: redisStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}

export const healthService = new HealthService();
