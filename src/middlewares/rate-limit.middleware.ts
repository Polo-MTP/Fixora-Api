import type { NextFunction, Request, Response } from 'express';

/**
 * API-43: límite de peticiones por ventana de tiempo, en memoria. La API corre en un solo
 * contenedor, así que basta; al reiniciarse, los contadores empiezan de cero.
 *
 * Detrás del proxy del servidor hay que poner TRUST_PROXY para que req.ip sea la IP real del
 * cliente y no la del proxy; si no, todos comparten el mismo contador.
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milisegundos hasta que la ventana vuelve a empezar. */
  resetInMs: number;
}

/** Contador por llave con ventana fija. Separado del middleware para probarlo solo. */
export class RateLimitStore {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly max: number;

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  hit(key: string, now = Date.now()): RateLimitResult {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.prune(now);
    return {
      allowed: entry.count <= this.max,
      limit: this.max,
      remaining: Math.max(0, this.max - entry.count),
      resetInMs: entry.resetAt - now,
    };
  }

  /** Quita las ventanas que ya terminaron, para que la memoria no crezca sin límite. */
  prune(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

export interface RateLimitOptions {
  name: string;
  windowMs: number;
  max: number;
  message: string;
  /** Qué se cuenta además de la IP; por ejemplo, el correo del cuerpo. */
  keyExtra?: (req: Request) => string | undefined;
}

export function rateLimit(options: RateLimitOptions) {
  const store = new RateLimitStore(options.windowMs, options.max);
  return (req: Request, res: Response, next: NextFunction) => {
    const extra = options.keyExtra?.(req);
    const key = `${options.name}:${req.ip ?? 'desconocida'}${extra ? `:${extra}` : ''}`;
    const result = store.hit(key);
    const resetSeconds = Math.ceil(result.resetInMs / 1000);
    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (result.allowed) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(resetSeconds));
    res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: options.message });
  };
}

/** El correo del cuerpo, normalizado, para contar intentos por cuenta y no solo por IP. */
export function emailFromBody(req: Request): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : undefined;
}

const MINUTE = 60_000;

/** Toda la API: holgado, para frenar abusos sin estorbar a la app (consulta cada pocos segundos). */
export const apiRateLimit = rateLimit({
  name: 'api',
  windowMs: MINUTE,
  max: 600,
  message: 'Demasiadas peticiones. Espera un momento e intenta de nuevo.',
});

/** Inicio de sesión, registro, códigos y recuperación: intentos por IP y correo. */
export const authAccountRateLimit = rateLimit({
  name: 'auth-cuenta',
  windowMs: 15 * MINUTE,
  max: 10,
  message: 'Demasiados intentos con esta cuenta. Espera 15 minutos e intenta de nuevo.',
  keyExtra: emailFromBody,
});

/** Los mismos, por IP sola: frena probar muchas cuentas desde el mismo lugar. */
export const authIpRateLimit = rateLimit({
  name: 'auth-ip',
  windowMs: 15 * MINUTE,
  max: 100,
  message: 'Demasiados intentos desde esta conexión. Espera 15 minutos e intenta de nuevo.',
});
