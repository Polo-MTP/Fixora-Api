import type { Request, Response, NextFunction } from 'express';
import { healthService } from '../services/health.service.ts';

export class HealthController {
  async check(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await healthService.getHealthStatus();
      res.json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const healthController = new HealthController();
