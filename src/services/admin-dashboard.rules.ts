/**
 * API-52: reglas del resumen del tablero del panel de administración, sin base de datos para
 * probarlas solas.
 */

/** Zona de la plataforma para los periodos del tablero (Torreón y Ciudad de México: UTC-6). */
export const PLATFORM_TIME_ZONE = 'America/Mexico_City';

/** Los estados públicos de una solicitud, en el orden en que avanza. */
export const SERVICE_STATUSES = [
  'pendiente',
  'aceptada',
  'agendada',
  'en_camino',
  'llegado',
  'completada',
  'cancelada',
  'expirada',
] as const;

/** Un reporte sigue abierto mientras no se resuelve ni se rechaza. */
export const OPEN_REPORT_STATUSES = ['pendiente', 'en_revision'] as const;

/**
 * Cuenta por estado con todos los estados presentes (los que no hubo, en 0). `en_curso` es el
 * nombre anterior de `en_camino` y se suma ahí.
 */
export function countByStatus(rows: Array<{ status: string; total: number }>) {
  const counts = Object.fromEntries(SERVICE_STATUSES.map((status) => [status, 0])) as Record<
    (typeof SERVICE_STATUSES)[number],
    number
  >;
  for (const row of rows) {
    const status = row.status === 'en_curso' ? 'en_camino' : row.status;
    if (status in counts) counts[status as keyof typeof counts] += Number(row.total);
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { total, by_status: counts };
}
