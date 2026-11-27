import type { NextFunction, Request, Response } from 'express';

/**
 * API-43: cabeceras de seguridad (lo esencial de helmet, sin agregar una dependencia) y la
 * lectura de CORS_ORIGIN y TRUST_PROXY.
 */

/** Rutas que sirven páginas o archivos para el navegador: no llevan la política de contenido. */
const NO_CSP_PREFIXES = ['/api/docs', '/api/files'];

export function securityHeaders(isProduction: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // La API solo responde JSON: no debe cargar nada ni dejarse incrustar.
    if (!NO_CSP_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    // En producción la API va por HTTPS: que el navegador no vuelva a intentar HTTP.
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}

/**
 * Orígenes permitidos por CORS (separados por coma). En producción tiene que haber una lista:
 * con «*» cualquier página podría llamar a la API desde el navegador de un usuario.
 */
export function parseCorsOrigins(
  value: string | undefined,
  isProduction: boolean,
): string | string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (isProduction && (!origins.length || origins.includes('*'))) {
    throw new Error(
      'CORS_ORIGIN es obligatorio en producción: escribe los orígenes permitidos separados por ' +
        'coma, por ejemplo https://fixora.sandialab.online',
    );
  }
  if (!origins.length || origins.includes('*')) return '*';
  return origins;
}

/**
 * TRUST_PROXY para Express: «true», un número de proxies (por ejemplo 1) o una lista de redes.
 * Sin él, req.ip es la del proxy y todos los clientes compartirían el límite de peticiones.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false') return false;
  if (trimmed === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** La ruta sin la consulta: ahí pueden ir firmas de enlaces o correos, que no deben quedar en los registros. */
export function pathForLog(originalUrl: string): string {
  return originalUrl.split('?')[0] ?? originalUrl;
}
