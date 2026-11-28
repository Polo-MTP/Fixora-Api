import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';

import { RateLimitStore, emailFromBody, rateLimit } from '../rate-limit.middleware.ts';
import {
  parseCorsOrigins,
  parseTrustProxy,
  pathForLog,
  securityHeaders,
} from '../security.middleware.ts';

/** Respuesta falsa: guarda cabeceras, estado y cuerpo. */
function fakeResponse() {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function run(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Partial<Request>,
) {
  const res = fakeResponse();
  let called = false;
  middleware(req as Request, res as unknown as Response, () => {
    called = true;
  });
  return { res, called };
}

describe('API-43: límite de peticiones', () => {
  it('deja pasar hasta el máximo y frena el siguiente', () => {
    const store = new RateLimitStore(60_000, 3);
    const now = 1_000_000;
    assert.equal(store.hit('a', now).remaining, 2);
    store.hit('a', now);
    assert.equal(store.hit('a', now).allowed, true);
    const blocked = store.hit('a', now + 10);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.resetInMs, 59_990);
  });

  it('cada llave lleva su cuenta y la ventana vuelve a empezar al terminar', () => {
    const store = new RateLimitStore(1_000, 1);
    store.hit('a', 0);
    assert.equal(store.hit('a', 500).allowed, false);
    assert.equal(store.hit('b', 500).allowed, true);
    assert.equal(store.hit('a', 1_000).allowed, true);
  });

  it('responde 429 con Retry-After y cuenta por IP y correo', () => {
    const limiter = rateLimit({
      name: 'prueba',
      windowMs: 60_000,
      max: 2,
      message: 'Demasiados intentos',
      keyExtra: emailFromBody,
    });
    const req = { ip: '10.0.0.1', body: { email: ' Ana@Correo.com ' } };
    run(limiter, req);
    run(limiter, { ...req, body: { email: 'ana@correo.com' } });
    const third = run(limiter, req);
    assert.equal(third.called, false);
    assert.equal(third.res.statusCode, 429);
    assert.deepEqual(third.res.body, {
      error: 'TOO_MANY_REQUESTS',
      message: 'Demasiados intentos',
    });
    assert.equal(third.res.headers['Retry-After'], '60');

    // Otra cuenta desde la misma IP todavía puede intentar.
    const other = run(limiter, { ip: '10.0.0.1', body: { email: 'beto@correo.com' } });
    assert.equal(other.called, true);
    assert.equal(other.res.headers['RateLimit-Remaining'], '1');
  });
});

describe('API-43: cabeceras de seguridad', () => {
  it('pone las cabeceras básicas y la política de contenido en la API', () => {
    const { res, called } = run(securityHeaders(false), { path: '/api/auth/login' });
    assert.equal(called, true);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    assert.match(res.headers['Content-Security-Policy'] ?? '', /default-src 'none'/);
    assert.equal(res.headers['Strict-Transport-Security'], undefined);
  });

  it('no pone la política de contenido en la documentación y sí HSTS en producción', () => {
    const { res } = run(securityHeaders(true), { path: '/api/docs/index.html' });
    assert.equal(res.headers['Content-Security-Policy'], undefined);
    assert.match(res.headers['Strict-Transport-Security'] ?? '', /max-age=/);
  });
});

describe('API-43: configuración de CORS, proxy y registros', () => {
  it('lee la lista de orígenes y quita la diagonal final', () => {
    assert.deepEqual(parseCorsOrigins('https://a.com/, https://b.com', true), [
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('en desarrollo acepta cualquier origen si no hay lista', () => {
    assert.equal(parseCorsOrigins(undefined, false), '*');
    assert.equal(parseCorsOrigins('*', false), '*');
  });

  it('en producción falla al arrancar sin lista o con *', () => {
    assert.throws(() => parseCorsOrigins(undefined, true), /CORS_ORIGIN/);
    assert.throws(() => parseCorsOrigins('*', true), /CORS_ORIGIN/);
    assert.throws(() => parseCorsOrigins(' , ', true), /CORS_ORIGIN/);
  });

  it('TRUST_PROXY acepta true, número de proxies o redes', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('loopback, 172.16.0.0/12'), 'loopback, 172.16.0.0/12');
  });

  it('el registro guarda la ruta sin la consulta', () => {
    assert.equal(
      pathForLog('/api/files/doc.pdf?signature=abc&email=a@b.com'),
      '/api/files/doc.pdf',
    );
    assert.equal(pathForLog('/api/health'), '/api/health');
  });
});
