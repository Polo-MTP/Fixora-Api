import { createClient } from 'redis';
import { ENV } from './env.ts';

// Redis guarda solo datos de tiempo real (temporizadores, posiciones, disponibilidad).
// Lo que debe sobrevivir a un reinicio va en PostgreSQL.
export const redis = createClient({
  url: ENV.REDIS_URL,
  // Sin conexión, los comandos fallan de inmediato en lugar de quedarse en cola esperando.
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 5000,
    // Reintenta con espera creciente, hasta 5 s entre intentos.
    reconnectStrategy: (retries) => Math.min((retries + 1) * 500, 5000),
  },
});

// node-redis emite un error por cada reintento; se avisa solo cuando cambia el estado.
let lastState: 'up' | 'down' | null = null;

redis.on('ready', () => {
  lastState = 'up';
  console.log('Redis conectado.');
});

redis.on('error', (error: NodeJS.ErrnoException) => {
  if (lastState === 'down') return;
  lastState = 'down';
  // Al rechazar la conexión, Node deja el mensaje vacío y el motivo queda en `code` (ECONNREFUSED).
  console.error(
    `Sin conexión con Redis (${ENV.REDIS_URL}); se seguirá reintentando.`,
    error.message || error.code,
  );
});

/**
 * Abre la conexión sin detener el arranque de la API: mientras Redis no responda, el cliente
 * sigue reintentando en segundo plano y /api/health lo reporta.
 */
export function connectRedis(): void {
  redis.connect().catch(() => {
    // El error ya se registró en el evento 'error'.
  });
}
