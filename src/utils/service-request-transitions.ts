/** Máquina completa de estados de una solicitud de servicio. */
const SERVICE_REQUEST_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
    pendiente: ['aceptada', 'agendada', 'cancelada', 'expirada'],
    aceptada: ['en_camino', 'cancelada'],
    agendada: ['en_camino', 'cancelada'],
    en_camino: ['llegado', 'cancelada'],
    llegado: ['completada', 'cancelada'],
    completada: [],
    cancelada: [],
    expirada: [],
};

export function isValidServiceRequestTransition(from: string, to: string): boolean {
    return SERVICE_REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}
