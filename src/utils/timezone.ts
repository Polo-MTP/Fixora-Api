/**
 * Conversión entre UTC (lo que guarda la base) y la hora local de cada sucursal. Se movió desde
 * service-request-creation.service.ts para que la use también la agenda (API-45).
 */

/** Hora local de [timeZone] (fecha AAAA-MM-DD y hora HH:mm) convertida a UTC. */
export function localDateTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const difference = target - represented;
    guess += difference;
    if (difference === 0) break;
  }
  return new Date(guess);
}

/** Fecha, hora y día de la semana (0 = domingo) de un instante en [timeZone]. */
export function utcToLocal(
  date: Date,
  timeZone: string,
): { date: string; time: string; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    dayOfWeek: weekdays[parts.weekday!]!,
  };
}

/** Suma [days] días a una fecha AAAA-MM-DD, sin depender de la zona horaria. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}
