import type { Request, Response, NextFunction } from 'express';

import { pathForLog } from './security.middleware.ts';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method } = req;
  // API-43: sin la consulta, que puede traer firmas de enlaces o correos.
  const path = pathForLog(req.originalUrl);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${method} ${path} ${statusCode} - ${duration}ms`);
  });

  next();
}
