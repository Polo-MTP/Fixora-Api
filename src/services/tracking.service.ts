import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import { ENV } from '../config/env.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { calculateHaversineDistanceKm } from '../utils/geo.utils.ts';
import { publishRealtimeMessage } from '../realtime/websocket.server.ts';
import {
  addresses,
  branches,
  business_supplier,
  employees,
  service_requests,
  suppliers,
} from '../database/schema/tables.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import type {
  RequestTrackingData,
  RouteEta,
  RouteLineStringGeometry,
  StoredTechnicianLocation,
  TechnicianLocationUpdate,
} from '../types/tracking.types.ts';

/** Intervalo mínimo entre consultas al motor de ruteo OSRM para la misma solicitud (1 minuto) */
export const MIN_RECALCULATION_INTERVAL_MS = 60_000;

/** Desviación física mínima en metros para forzar recálculo antes del intervalo */
export const SIGNIFICANT_DEVIATION_METERS = 250;

/** TTL en segundos para los datos de ubicación y ruta en Redis (1 hora) */
export const TRACKING_TTL_SECONDS = 3600;

/** Velocidad promedio de traslado urbano en m/s (25 km/h ≈ 6.94 m/s) */
const URBAN_AVERAGE_SPEED_MPS = 6.94;

/** Factor de curvatura urbana respecto a la distancia euclidiana en línea recta */
const URBAN_CURVATURE_FACTOR = 1.3;

function encodeSignedNumber(num: number): string {
  let sgnNum = num << 1;
  if (num < 0) {
    sgnNum = ~sgnNum;
  }
  let encoded = '';
  while (sgnNum >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  encoded += String.fromCharCode(sgnNum + 63);
  return encoded;
}

/**
 * Codifica una lista de coordenadas GeoJSON [lng, lat] en formato polyline estándar (precisión 5).
 */
export function encodePolylineFromLngLat(coordinates: [number, number][]): string {
  let prevLat = 0;
  let prevLng = 0;
  let result = '';
  for (const [lng, lat] of coordinates) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    result += encodeSignedNumber(latE5 - prevLat);
    result += encodeSignedNumber(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return result;
}

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
        branchId: service_requests.branch_id,
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

    // 2. Validar que el usuario sea el técnico asignado (empleado o proveedor independiente)
    const canReport = await this.canReportTechnicianLocation(
      actorId,
      request.employeeId,
      request.branchId,
    );
    if (!canReport) {
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

    // 5. Calcular o reutilizar ruta y ETA para MapLibre + OpenFreeMap vía OSRM (API-33)
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
            polyline: routeEta.polyline,
            geometry: routeEta.geometry,
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
   * Obtiene la ruta y ETA de Redis si aún es vigente, o recalcula con el motor OSRM (OpenStreetMap)
   * cuidando el límite de uso mediante intervalo y detección de desvío (API-33).
   */
  async getOrCalculateRouteEta(
    requestId: bigint | string,
    technicianLat: number,
    technicianLng: number,
    destLat: number,
    destLng: number,
    forceRecalculate = false,
    customFetch: typeof fetch = fetch,
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

    // Recalcular ruta y tiempo estimado con OSRM para MapLibre + OpenFreeMap
    const result = await this.calculateRouteWithOsrm(
      technicianLat,
      technicianLng,
      destLat,
      destLng,
      customFetch,
    );

    const routeEta: RouteEta = {
      duration_seconds: result.duration_seconds,
      distance_meters: result.distance_meters,
      eta_timestamp: result.eta_timestamp,
      polyline: result.polyline,
      geometry: result.geometry,
      last_calculated_at: now,
      last_technician_lat: technicianLat,
      last_technician_lng: technicianLng,
      is_fallback: result.is_fallback,
    };

    await this.cacheSet(key, JSON.stringify(routeEta));

    return routeEta;
  }

  /**
   * Consulta al motor de ruteo OSRM (OpenStreetMap) devolviendo geometría GeoJSON LineString
   * nativa para MapLibre + OpenFreeMap y polilínea codificada, con timeout y fallback (API-33).
   */
  async calculateRouteWithOsrm(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    customFetch: typeof fetch = fetch,
    baseUrl: string = ENV.ROUTING_API_URL,
  ): Promise<{
    duration_seconds: number;
    distance_meters: number;
    eta_timestamp: string;
    polyline: string | null;
    geometry: RouteLineStringGeometry | null;
    is_fallback: boolean;
  }> {
    if (!baseUrl || !baseUrl.trim()) {
      return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
    }

    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout

    try {
      // Estándar OSRM / GeoJSON / MapLibre: longitud primero, latitud después ({lng},{lat})
      const url = `${cleanBaseUrl}/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;

      const response = await customFetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
      }

      const data = (await response.json()) as {
        code?: string;
        routes?: Array<{
          distance?: number;
          duration?: number;
          geometry?: {
            type?: string;
            coordinates?: [number, number][];
          };
        }>;
      };

      if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        const durationSeconds = Math.max(1, Math.round(route.duration ?? 0));
        const distanceMeters = Math.round(route.distance ?? 0);
        const rawCoords = Array.isArray(route.geometry?.coordinates)
          ? route.geometry.coordinates
          : [[originLng, originLat] as [number, number], [destLng, destLat] as [number, number]];

        const geometry: RouteLineStringGeometry = {
          type: 'LineString',
          coordinates: rawCoords,
        };
        const polyline = encodePolylineFromLngLat(rawCoords);
        const etaTimestamp = new Date(Date.now() + durationSeconds * 1000).toISOString();

        return {
          duration_seconds: durationSeconds,
          distance_meters: distanceMeters,
          eta_timestamp: etaTimestamp,
          polyline,
          geometry,
          is_fallback: false,
        };
      }

      return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
    } catch {
      clearTimeout(timeoutId);
      return this.calculateEstimatedRoute(originLat, originLng, destLat, destLng);
    }
  }

  /**
   * Cálculo estimado de ruta mediante fórmula Haversine y velocidad promedio urbana (fallback) (API-33).
   * Genera también una geometría LineString directa para que MapLibre pueda trazar la línea.
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
    geometry: RouteLineStringGeometry;
    is_fallback: boolean;
  } {
    const distanceKm = calculateHaversineDistanceKm(originLat, originLng, destLat, destLng);
    const directMeters = distanceKm * 1000;
    const distanceMeters = Math.round(directMeters * URBAN_CURVATURE_FACTOR);

    // Mínimo 60 segundos de traslado estimado
    const durationSeconds = Math.max(60, Math.round(distanceMeters / URBAN_AVERAGE_SPEED_MPS));
    const etaTimestamp = new Date(Date.now() + durationSeconds * 1000).toISOString();

    const coordinates: [number, number][] = [
      [originLng, originLat],
      [destLng, destLat],
    ];

    return {
      duration_seconds: durationSeconds,
      distance_meters: distanceMeters,
      eta_timestamp: etaTimestamp,
      polyline: encodePolylineFromLngLat(coordinates),
      geometry: {
        type: 'LineString',
        coordinates,
      },
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
   * Verifica si el usuario autenticado es el técnico asignado a la solicitud
   * (sea cuenta con rol 'empleado' o proveedor independiente dueño de la sucursal).
   */
  async canReportTechnicianLocation(
    actorId: bigint,
    employeeId: bigint | null,
    branchId: bigint | null,
  ): Promise<boolean> {
    if (employeeId !== null) {
      const [assignment] = await db
        .select({ id: employees.UniqueID })
        .from(employees)
        .where(
          and(
            eq(employees.UniqueID, employeeId),
            eq(employees.user_id, actorId),
            eq(employees.active, true),
          ),
        )
        .limit(1);

      if (assignment) return true;
    }

    if (branchId !== null) {
      const [independentOwner] = await db
        .select({ id: branches.UniqueID })
        .from(branches)
        .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
        .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
        .where(
          and(
            eq(branches.UniqueID, branchId),
            eq(suppliers.user_id, actorId),
            eq(suppliers.supplier_type, 'independiente'),
            eq(suppliers.active, true),
            eq(business_supplier.active, true),
          ),
        )
        .limit(1);

      if (independentOwner) return true;
    }

    return false;
  }

  /**
   * Verifica de forma estricta que solo los involucrados directos en la solicitud
   * puedan consultar la ubicación y el ETA en tiempo real (evita fugas de privacidad).
   */
  async canAccessRequestTracking(
    actor: { id: string; role: string },
    request: { clientId: bigint; employeeId: bigint | null; branchId: bigint | null },
  ): Promise<boolean> {
    const actorId = BigInt(actor.id);
    const role = actor.role.trim().toLowerCase();

    if (role === 'cliente') {
      return request.clientId === actorId;
    }

    if (role === 'empleado') {
      if (request.employeeId === null) return false;
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
      return Boolean(assignment);
    }

    if (role === 'gerente') {
      if (request.branchId === null) return false;
      const [branchAssignment] = await db
        .select({ id: employees.UniqueID })
        .from(employees)
        .where(
          and(
            eq(employees.user_id, actorId),
            eq(employees.branch_id, request.branchId),
            eq(employees.active, true),
          ),
        )
        .limit(1);
      return Boolean(branchAssignment);
    }

    if (role === 'proveedor') {
      if (request.employeeId !== null) {
        const [directAssignment] = await db
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
        if (directAssignment) return true;
      }

      if (request.branchId !== null) {
        const [ownedBranch] = await db
          .select({ id: branches.UniqueID })
          .from(branches)
          .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
          .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
          .where(
            and(
              eq(branches.UniqueID, request.branchId),
              eq(suppliers.user_id, actorId),
              eq(suppliers.active, true),
              eq(business_supplier.active, true),
            ),
          )
          .limit(1);
        if (ownedBranch) return true;
      }

      return false;
    }

    return false;
  }

  /**
   * Consulta el estado de tracking actual (posición y ruta/ETA) de una solicitud (API-33).
   */
  async getRequestTracking(
    requestId: bigint,
    actor: { id: string; role: string },
  ): Promise<RequestTrackingData> {
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

    // Validar permisos de acceso para todos los roles (evitar fuga de privacidad entre cuentas/sucursales)
    const allowed = await this.canAccessRequestTracking(actor, request);
    if (!allowed) {
      throw new ForbiddenError(
        'No tienes permiso para consultar el tracking de esta solicitud.',
        'INSUFFICIENT_PERMISSIONS',
      );
    }

    const currentStatus = request.status === 'en_curso' ? 'en_camino' : request.status;

    let storedLocation: StoredTechnicianLocation | null = null;
    let storedEta: RouteEta | null = null;

    // Solo exponer ubicación y ruta mientras el técnico está efectivamente en camino
    if (currentStatus === 'en_camino') {
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
    }

    return {
      requestId: requestId.toString(),
      status: currentStatus,
      map_style_url: ENV.OPENFREEMAP_STYLE_URL,
      technician_location: storedLocation,
      route_eta: storedEta
        ? {
            duration_seconds: storedEta.duration_seconds,
            distance_meters: storedEta.distance_meters,
            eta_timestamp: storedEta.eta_timestamp,
            polyline: storedEta.polyline,
            geometry: storedEta.geometry ?? null,
            is_fallback: storedEta.is_fallback,
          }
        : null,
    };
  }
}

export const trackingService = new TrackingService();
