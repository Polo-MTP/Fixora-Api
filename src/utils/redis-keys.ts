// Convención de claves en Redis: `fixora:<entidad>:<id>:<dato>`, todo en minúsculas.
// Cada clave se arma aquí para que nadie escriba nombres a mano en los servicios.

const PREFIX = 'fixora';

export const redisKeys = {
  /** Temporizador de una solicitud (los 5 minutos para que un proveedor responda). */
  requestTimer: (requestId: bigint | string) => `${PREFIX}:request:${requestId}:timer`,

  /** Índice geográfico con la última posición de cada técnico en línea. */
  technicianPositions: () => `${PREFIX}:technicians:positions`,

  /** Marca de «en línea» de un técnico; expira si deja de reportarse. */
  technicianOnline: (employeeId: bigint | string) => `${PREFIX}:technician:${employeeId}:online`,
} as const;
