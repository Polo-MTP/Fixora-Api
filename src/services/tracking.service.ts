import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import { ENV } from '../config/env.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { calculateHaversineDistanceKm } from '../utils/geo.utils.ts';
import { publishRealtimeMessage } from '../realtime/websocket.server.ts';
import { addresses, employees, service_requests } from '../database/schema/tables.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import type {
  RequestTrackingData,
  RouteEta,
  StoredTechnicianLocation,
  TechnicianLocationUpdate,
} from '../types/tracking.types.ts';

/** Intervalo mínimo entre consultas a Google Maps para la misma solicitud (1 minuto) */
export const MIN_RECALCULATION_INTERVAL_MS = 60_000;

/** Desviación física mínima en metros para forzar recálculo antes del intervalo */
export const SIGNIFICANT_DEVIATION_METERS = 250;

/** TTL en segundos para los datos de ubicación y ruta en Redis (1 hora) */
export const TRACKING_TTL_SECONDS = 3600;

/** Velocidad promedio de traslado urbano en m/s (25 km/h ≈ 6.94 m/s) */
const URBAN_AVERAGE_SPEED_MPS = 6.94;

/** Factor de curvatura urbana respecto a la distancia euclidiana en línea recta */
const URBAN_CURVATURE_FACTOR = 1.3;

export class TrackingService {
  private inMemoryCache = new Map<string, string>();

  async cacheSet(key: string, value: string, ttlSeconds = TRACKING_TTL_SECONDS): Promise<void> {
    this.inMemoryCache.set(key, value);
    if (redis.isOpen) {
      try {
        await redis.set(key, value, { EX: ttlSeconds });
      } catch (err) {
        console.error('[TrackingService] Error al guardar en Redis:', err);
      }
    }
  }

  async cacheGet(key: string): Promise<string | null> {
    if (redis.isOpen) {
      try {
        const val = await redis.get(key);
        if (val) return val;
      } catch {
        // Fallback a memoria local
      }
    }
    return this.inMemoryCache.get(key) ?? null;
  }

  async cacheDel(key: string): Promise<void> {
    this.inMemoryCache.delete(key);
    if (redis.isOpen) {
      try {
        await redis.del(key);
      } catch (err) {
        console.error('[TrackingService] Error al borrar de Redis:', err);
      }
    }
  }

  /**
   * Guarda la posición del técnico en Redis durante el traslado de una solicitud,
   * actualiza o reutiliza la ruta/ETA calculada y difunde la actualización en tiempo real (API-32).
   */
  async recordTechnicianLocation(
    requestId: bigint | string,
    userId: string,
    update: TechnicianLocationUpdate,
  ): Promise<{ location: StoredTechnicianLocation; routeEta: RouteEta | null }> {
    const numericRequestId = BigInt(requestId);
    const actorId = BigInt(userId);

    // 1. Obtener la solicitud y validar estado de traslado
    const [request] = await db
      .select({
        id: service_requests.UniqueID,
        status: service_requests.status,
        clientId: service_requests.client_id,
        employeeId: service_requests.employee_id,
        addressId: service_requests.address_id,
        latitude: service_requests.latitude,
        longitude: service_requests.longitude,
      })
      .from(service_requests)
      .where(eq(service_requests.UniqueID, numericRequestId))
      .limit(1);

    if (!request) {
      throw new NotFoundError('La solicitud de servicio no existe.');
    }

    // Normalizar estado (en_curso se mapea a en_camino)
    const currentStatus = request.status === 'en_curso' ? 'en_camino' : request.status;
    if (currentStatus !== 'en_camino') {
      throw new ConflictError(
        'Solo se reciben posiciones cuando la solicitud está en estado "en_camino".',
        'NOT_IN_TRANSIT',
      );
    }

    // 2. Validar que el usuario sea el técnico asignado a la solicitud
    if (!request.employeeId) {
      throw new ForbiddenError(
        'La solicitud no tiene un técnico asignado.',
        'INSUFFICIENT_PERMISSIONS',
      );
    }

    const [assignment] = await db
      .select({ id: employees.UniqueID })
      .from(employees)
      .where(
        and(
          eq(employees.UniqueID, request.employeeId),
          eq(employees.user_id, actorId),
          eq(employees.active, true),
        ),
      )
      .limit(1);

    if (!assignment) {
      throw new ForbiddenError(
        'Solo el técnico asignado a esta solicitud puede reportar su posición.',
        'INSUFFICIENT_PERMISSIONS',
      );
    }

    // 3. Persistir la última posición en Redis con expiración automática
    const timestamp = update.timestamp || new Date().toISOString();
    const storedLocation: StoredTechnicianLocation = {
      latitude: update.latitude,
      longitude: update.longitude,
      heading: typeof update.heading === 'number' ? update.heading : null,
      speed: typeof update.speed === 'number' ? update.speed : null,
      updated_at: timestamp,
    };

    await this.cacheSet(
      redisKeys.requestTechnicianLocation(numericRequestId),
      JSON.stringify(storedLocation),
    );

    // 4. Determinar coordenadas de destino del cliente
    let destLat: number | null = null;
    let destLng: number | null = null;

    if (request.latitude !== null && request.longitude !== null) {
      destLat = Number(request.latitude);
      destLng = Number(request.longitude);
    } else if (request.addressId) {
      const [address] = await db
        .select({
          latitude: addresses.latitude,
          longitude: addresses.longitude,
        })
        .from(addresses)
        .where(eq(addresses.UniqueID, request.addressId))
        .limit(1);

      if (address?.latitude !== null && address?.longitude !== null) {
        destLat = Number(address.latitude);
        destLng = Number(address.longitude);
      }
    }

    // 5. Calcular o reutilizar ruta y ETA con Google Maps (API-33)
    let routeEta: RouteEta | null = null;
    if (
      destLat !== null &&
      destLng !== null &&
      Number.isFinite(destLat) &&
      Number.isFinite(destLng)
    ) {
      try {
        routeEta = await this.getOrCalculateRouteEta(
          numericRequestId,
          update.latitude,
          update.longitude,
          destLat,
          destLng,
        );
      } catch (err) {
        console.error('[TrackingService] Error al calcular ruta/ETA:', err);
      }
    }

    // 6. Reenviar en tiempo real al cliente por WebSocket (API-32)
    const realtimePayload = {
      requestId: numericRequestId.toString(),
      latitude: storedLocation.latitude,
      longitude: storedLocation.longitude,
      heading: storedLocation.heading,
      speed: storedLocation.speed,
      timestamp: storedLocation.updated_at,
      eta: routeEta
        ? {
            duration_seconds: routeEta.duration_seconds,
            distance_meters: routeEta.distance_meters,
            eta_timestamp: routeEta.eta_timestamp,
            is_fallback: routeEta.is_fallback,
          }
        : null,
    };

    const now = new Date();
    // Canal de la solicitud (escuchado por cliente y técnico)
    publishRealtimeMessage({
      channel: `requests:${numericRequestId}`,
      event: 'technician_location',
      data: realtimePayload,
      timestamp: now,
    });

    // Canal directo del cliente
    publishRealtimeMessage({
      channel: `users:${request.clientId}`,
      event: 'technician_location',
      data: realtimePayload,
      timestamp: now,
    });

    return { location: storedLocation, routeEta };
  }

  /**
   * Obtiene la ruta y ETA de Redis si aún es vigente, o recalcula con Google Maps
   * cuidando la cuota gratuita mediante intervalo y detección de desvío (API-33).
   */
  async getOrCalculateRouteEta(
    requestId: bigint | string,
    technicianLat: number,
    technicianLng: number,
    destLat: number,
    destLng: number,
    forceRecalculate = false,
  ): Promise<RouteEta> {
    const key = redisKeys.requestRouteEta(requestId);
    const now = Date.now();

    // Consultar caché en Redis o memoria local
    let cached: RouteEta | null = null;
    const raw = await this.cacheGet(key);
    if (raw) {
      try {
        cached = JSON.parse(raw) as RouteEta;
      } catch {
        cached = null;
      }
    }

    let shouldRecalculate = forceRecalculate || cached === null;

    if (cached && !shouldRecalculate) {
      const elapsedMs = now - cached.last_calculated_at;

      // 1. Condición por tiempo: si pasó el intervalo mínimo, recalcular
      if (elapsedMs >= MIN_RECALCULATION_INTERVAL_MS) {
        shouldRecalculate = true;
      } else {
        // 2. Condición por desvío: distancia recorrida desde la última posición calculada
        const distanceFromLastCheckKm = calculateHaversineDistanceKm(
          technicianLat,
          technicianLng,
          cached.last_technician_lat,
          cached.last_technician_lng,
        );
        const distanceFromLastMeters = distanceFromLastCheckKm * 1000;

        if (distanceFromLastMeters >= SIGNIFICANT_DEVIATION_METERS) {
          const currentDistanceToDestKm = calculateHaversineDistanceKm(
            technicianLat,
            technicianLng,
            destLat,
            destLng,
          );
          const previousDistanceToDestKm = calculateHaversineDistanceKm(
            cached.last_technician_lat,
            cached.last_technician_lng,
            destLat,
            destLng,
          );

          // Si se alejó del destino o no progresó en la ruta esperada, se considera desvío
          if (currentDistanceToDestKm > previousDistanceToDestKm + 0.1) {
            shouldRecalculate = true;
          }
        }
      }
    }

    if (!shouldRecalculate && cached) {
      // Reutilizar cálculo previo deduciendo el tiempo transcurrido
      const elapsedSeconds = Math.round((now - cached.last_calculated_at) / 1000);
      const remainingSeconds = Math.max(0, cached.duration_seconds - elapsedSeconds);
      const etaTimestamp = new Date(
        cached.last_calculated_at + cached.duration_seconds * 1000,
      ).toISOString();

      return {
        ...cached,
        duration_seconds: remainingSeconds,
        eta_timestamp: etaTimestamp,
      };
    }

    // Recalcular ruta y tiempo estimado
    const result = await this.calculateRouteWithGoogleMaps(
      technicianLat,
      technicianLng,
      destLat,
      destLng,
    );

    const routeEta: RouteEta = {
      duration_seconds: result.duration_seconds,
      distance_meters: result.distance_meters,
      eta_timestamp: result.eta_timestamp,
      polyline: result.polyline,
      last_calculated_at: now,
      last_technician_lat: technicianLat,
      last_technician_lng: technicianLng,
      is_fallback: result.is_fallback,
    };

    await this.cacheSet(key, JSON.stringify(routeEta));

    return routeEta;
  }

  /**
   * Consulta a la API de Google Maps Directions con timeout y degradación elegante a cálculo estimado (API-33).
   */
  async calculateRouteWithGoogleMaps(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<{
    duration_seconds: number;
    distance_meters: number;
    eta_timestamp: string;
    polyline: string | null;
    is_fallback: boolean;
  }> {
    const apiKey = ENV.GOOGLE_MAPS_API_KEY;

    // Si no se configuró API key, recurrir directamente al cálculo estimado
    if (!apiKey || !apiKey.trim()) {
      return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout

    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}&destination=${destLat},${destLng}&mode=driving&key=${encodeURIComponent(apiKey)}`;

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
      }

      const data = (await response.json()) as {
        status?: string;
        routes?: Array<{
          overview_polyline?: { points?: string };
          legs?: Array<{
            distance?: { value?: number };
            duration?: { value?: number };
          }>;
        }>;
      };

      if (data.status === 'OK' && data.routes && data.routes.length > 0) {
        const leg = data.routes[0].legs?.[0];
        const durationSeconds = leg?.duration?.value ?? 0;
        const distanceMeters = leg?.distance?.value ?? 0;
        const polyline = data.routes[0].overview_polyline?.points ?? null;

        const etaTimestamp = new Date(Date.now() + durationSeconds * 1000).toISOString();

        return {
          duration_seconds: durationSeconds,
          distance_meters: distanceMeters,
          eta_timestamp: etaTimestamp,
          polyline,
          is_fallback: false,
        };
      }

      // Si Google responde OVER_QUERY_LIMIT, REQUEST_DENIED o ZERO_RESULTS, usar fallback
      return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
    } catch {
      clearTimeout(timeoutId);
      return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
    }
  }

  /**
   * Cálculo estimado de ruta mediante fórmula Haversine y velocidad promedio urbana (fallback) (API-33).
   */
  calculateEstimatedRoute(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): {
    duration_seconds: number;
    distance_meters: number;
    eta_timestamp: string;
    polyline: string | null;
    is_fallback: boolean;
  } {
    const distanceKm = calculateHaversineDistanceKm(originLat, originLng, destLat, destLng);
    const directMeters = distanceKm * 1000;
    const distanceMeters = Math.round(directMeters * URBAN_CURVATURE_FACTOR);

    // Mínimo 60 segundos de traslado estimado
    const durationSeconds = Math.max(60, Math.round(distanceMeters / URBAN_AVERAGE_SPEED_MPS));
    const etaTimestamp = new Date(Date.now() + durationSeconds * 1000).toISOString();

    return {
      duration_seconds: durationSeconds,
      distance_meters: distanceMeters,
      eta_timestamp: etaTimestamp,
      polyline: null,
      is_fallback: true,
    };
  }

  /**
   * Borra de Redis la posición y ruta en curso al finalizar o cancelar la solicitud (API-32).
   */
  async clearRequestTracking(requestId: bigint | string): Promise<void> {
    await this.cacheDel(redisKeys.requestTechnicianLocation(requestId));
    await this.cacheDel(redisKeys.requestRouteEta(requestId));
  }

  /**
   * Consulta el estado de tracking actual (posición y ruta/ETA) de una solicitud (API-33).
   */
  async getRequestTracking(
    requestId: bigint,
    actor: { id: string; role: string },
  ): Promise<RequestTrackingData> {
    const actorId = BigInt(actor.id);
    const role = actor.role.trim().toLowerCase();

    const [request] = await db
      .select({
        id: service_requests.UniqueID,
        status: service_requests.status,
        clientId: service_requests.client_id,
        employeeId: service_requests.employee_id,
        branchId: service_requests.branch_id,
      })
      .from(service_requests)
      .where(eq(service_requests.UniqueID, requestId))
      .limit(1);

    if (!request) {
      throw new NotFoundError('La solicitud de servicio no existe.');
    }

    // Validar permisos de acceso
    if (role === 'cliente' && request.clientId !== actorId) {
      throw new ForbiddenError(
        'No tienes permiso para consultar el tracking de esta solicitud.',
        'INSUFFICIENT_PERMISSIONS',
      );
    }

    let storedLocation: StoredTechnicianLocation | null = null;
    let storedEta: RouteEta | null = null;

    try {
      const rawLocation = await this.cacheGet(redisKeys.requestTechnicianLocation(requestId));
      if (rawLocation) {
        storedLocation = JSON.parse(rawLocation) as StoredTechnicianLocation;
      }

      const rawEta = await this.cacheGet(redisKeys.requestRouteEta(requestId));
      if (rawEta) {
        storedEta = JSON.parse(rawEta) as RouteEta;
      }
    } catch {
      // Ignorar fallos de formato y devolver null
    }

    const currentStatus = request.status === 'en_curso' ? 'en_camino' : request.status;

    return {
      requestId: requestId.toString(),
      status: currentStatus,
      technician_location: storedLocation,
      route_eta: storedEta
        ? {
            duration_seconds: storedEta.duration_seconds,
            distance_meters: storedEta.distance_meters,
            eta_timestamp: storedEta.eta_timestamp,
            polyline: storedEta.polyline,
            is_fallback: storedEta.is_fallback,
          }
        : null,
    };
  }
}

export const trackingService = new TrackingService();
