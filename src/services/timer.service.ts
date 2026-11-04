import { redis } from '../config/redis.ts';

// Temporizadores con expiración en Redis: la clave existe mientras el tiempo corre y Redis la
// borra sola al vencer, así que no hace falta guardar ni limpiar nada en PostgreSQL.

export class TimerService {
  /** Inicia (o reinicia) un temporizador de `seconds` segundos. */
  async start(key: string, seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new RangeError('La duración del temporizador debe ser un entero positivo.');
    }

    await redis.set(key, Date.now().toString(), { expiration: { type: 'EX', value: seconds } });
  }

  /** Segundos que le quedan al temporizador; 0 si ya venció o no existe. */
  async remainingSeconds(key: string): Promise<number> {
    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : 0;
  }

  /** Detiene el temporizador antes de que venza (por ejemplo, al aceptar la solicitud). */
  async cancel(key: string): Promise<boolean> {
    return (await redis.del(key)) > 0;
  }
}

export const timerService = new TimerService();
