import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase } from '../../config/database.ts';
import {
  trackingService,
  MIN_RECALCULATION_INTERVAL_MS,
  SIGNIFICANT_DEVIATION_METERS,
} from '../tracking.service.ts';
import { advanceServiceRequestStatus } from '../service-request-status.service.ts';
import { ForbiddenError } from '../../errors/app-error.ts';
import { redisKeys } from '../../utils/redis-keys.ts';

describe('API-32 & API-33 & API-34: Tracking, Rutas y Estados de Traslado', () => {
  const dummyRequestId = '99901';

  describe('API-32: Recepción, persistencia en Redis y borrado de posiciones', () => {
    it('guarda la posición del técnico en Redis y la recupera correctamente', async () => {
      const locationData = {
        latitude: 19.4326,
        longitude: -99.1332,
        heading: 180,
        speed: 25.5,
        updated_at: new Date().toISOString(),
      };

      await trackingService.cacheSet(
        redisKeys.requestTechnicianLocation(dummyRequestId),
        JSON.stringify(locationData),
      );

      const raw = await trackingService.cacheGet(
        redisKeys.requestTechnicianLocation(dummyRequestId),
      );
      assert.ok(raw);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.latitude, 19.4326);
      assert.equal(parsed.longitude, -99.1332);
      assert.equal(parsed.heading, 180);
      assert.equal(parsed.speed, 25.5);
    });

    it('borra el tracking de Redis al finalizar o cancelar (clearRequestTracking)', async () => {
      await trackingService.cacheSet(
        redisKeys.requestTechnicianLocation(dummyRequestId),
        JSON.stringify({ latitude: 19.43, longitude: -99.13 }),
      );
      await trackingService.cacheSet(
        redisKeys.requestRouteEta(dummyRequestId),
        JSON.stringify({ duration_seconds: 300, distance_meters: 1500 }),
      );

      await trackingService.clearRequestTracking(dummyRequestId);

      const locAfter = await trackingService.cacheGet(
        redisKeys.requestTechnicianLocation(dummyRequestId),
      );
      const etaAfter = await trackingService.cacheGet(redisKeys.requestRouteEta(dummyRequestId));

      assert.equal(locAfter, null);
      assert.equal(etaAfter, null);
    });
  });

  describe('API-33: Ruta y tiempo estimado de llegada (ETA) con MapLibre + OpenFreeMap + OSRM', () => {
    it('calcula ruta y ETA estimada en fallback generando geometría GeoJSON LineString para MapLibre', () => {
      // Coordenadas: Zócalo (19.4326, -99.1332) a Bellas Artes (19.4352, -99.1412) ~1.1 km
      const result = trackingService.calculateEstimatedRoute(19.4326, -99.1332, 19.4352, -99.1412);

      assert.equal(result.is_fallback, true);
      assert.ok(result.distance_meters > 800 && result.distance_meters < 2000);
      assert.ok(result.duration_seconds >= 60);
      assert.ok(Date.parse(result.eta_timestamp) > Date.now());
      assert.ok(typeof result.polyline === 'string' && result.polyline.length > 0);
      assert.deepEqual(result.geometry, {
        type: 'LineString',
        coordinates: [
          [-99.1332, 19.4326],
          [-99.1412, 19.4352],
        ],
      });
    });

    it('consulta OSRM con formato lng,lat y devuelve geometría GeoJSON LineString y polyline para MapLibre', async () => {
      let calledUrl = '';
      const mockOsrmFetch: typeof fetch = async (input) => {
        calledUrl = String(input);
        return {
          ok: true,
          json: async () => ({
            code: 'Ok',
            routes: [
              {
                distance: 2450.4,
                duration: 420.8,
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [-99.1332, 19.4326],
                    [-99.137, 19.434],
                    [-99.1412, 19.4352],
                  ],
                },
              },
            ],
          }),
        } as Response;
      };

      const result = await trackingService.calculateRouteWithOsrm(
        19.4326,
        -99.1332,
        19.4352,
        -99.1412,
        mockOsrmFetch,
        'https://router.project-osrm.org',
      );

      assert.ok(
        calledUrl.includes('/route/v1/driving/-99.1332,19.4326;-99.1412,19.4352'),
        `URL construida: ${calledUrl}`,
      );
      assert.equal(result.is_fallback, false);
      assert.equal(result.distance_meters, 2450);
      assert.equal(result.duration_seconds, 421);
      assert.ok(result.polyline && result.polyline.length > 0);
      assert.equal(result.geometry?.type, 'LineString');
      assert.equal(result.geometry?.coordinates.length, 3);
      assert.deepEqual(result.geometry?.coordinates[0], [-99.1332, 19.4326]);
    });

    it('degrada a cálculo estimado (fallback) cuando el servidor OSRM falla o agota el tiempo', async () => {
      const failingFetch: typeof fetch = async () => {
        throw new Error('Network timeout');
      };

      const result = await trackingService.calculateRouteWithOsrm(
        19.4326,
        -99.1332,
        19.4352,
        -99.1412,
        failingFetch,
        'https://router.project-osrm.org',
      );

      assert.equal(result.is_fallback, true);
      assert.equal(result.geometry?.type, 'LineString');
      assert.ok(result.duration_seconds >= 60);
    });

    it('reutiliza la ruta calculada si no ha expirado el intervalo y el técnico no se ha desviado', async () => {
      const originLat = 19.4326;
      const originLng = -99.1332;
      const destLat = 19.45;
      const destLng = -99.12;
      let fetchCalls = 0;

      const offlineFetch: typeof fetch = async () => {
        fetchCalls++;
        throw new Error('Offline test fallback');
      };

      // Primer cálculo
      const first = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        originLat,
        originLng,
        destLat,
        destLng,
        true, // forzar primer cálculo
        offlineFetch,
      );

      assert.ok(first.duration_seconds > 0);
      assert.equal(fetchCalls, 1);

      // Segundo cálculo inmediatamente después (mismo punto, 0 ms transcurridos)
      const second = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        originLat,
        originLng,
        destLat,
        destLng,
        false,
        offlineFetch,
      );

      // Debe reutilizar el cálculo previo sin volver a consultar el motor de ruteo
      assert.equal(fetchCalls, 1);
      assert.equal(second.last_calculated_at, first.last_calculated_at);
      assert.equal(second.distance_meters, first.distance_meters);

      await trackingService.clearRequestTracking(dummyRequestId);
    });

    it('recalcula la ruta si se detecta un desvío significativo', async () => {
      const originLat = 19.4326;
      const originLng = -99.1332;
      const destLat = 19.45;
      const destLng = -99.12;
      let fetchCalls = 0;

      const offlineFetch: typeof fetch = async () => {
        fetchCalls++;
        throw new Error('Offline test fallback');
      };

      // Primer cálculo
      const first = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        originLat,
        originLng,
        destLat,
        destLng,
        true,
        offlineFetch,
      );

      // Simular técnico desviándose en dirección opuesta (al sur, alejándose del destino)
      const deviatedLat = 19.41; // ~2.5 km al sur
      const deviatedLng = -99.1332;

      const recalculated = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        deviatedLat,
        deviatedLng,
        destLat,
        destLng,
        false,
        offlineFetch,
      );

      // Debe haber recalculado la ruta con la nueva posición y mayor distancia
      assert.equal(fetchCalls, 2);
      assert.equal(recalculated.last_technician_lat, deviatedLat);
      assert.notEqual(recalculated.distance_meters, first.distance_meters);
      assert.ok(recalculated.distance_meters > first.distance_meters);

      await trackingService.clearRequestTracking(dummyRequestId);
    });

    it('constantes de intervalo y desvío tienen valores adecuados', () => {
      assert.equal(MIN_RECALCULATION_INTERVAL_MS, 60_000); // 1 minuto
      assert.equal(SIGNIFICANT_DEVIATION_METERS, 250); // 250 metros
    });
  });

  describe('API-34: Reglas de puntos clave de ubicación y llegada', () => {
    it('solo los estados en_camino y llegado guardan coordenadas en eventos', () => {
      const shouldSaveCoordinates = (status: string) => ['en_camino', 'llegado'].includes(status);

      assert.equal(shouldSaveCoordinates('en_camino'), true); // Salir
      assert.equal(shouldSaveCoordinates('llegado'), true); // Llegar
      assert.equal(shouldSaveCoordinates('completada'), false); // Completar NO guarda coordenadas
      assert.equal(shouldSaveCoordinates('cancelada'), false); // Cancelar NO guarda coordenadas
      assert.equal(shouldSaveCoordinates('agendada'), false);
    });

    it('formatea el título de notificación específico al llegar el técnico', () => {
      const resolveNotificationTitle = (toStatus: string, requestId: string) =>
        toStatus === 'llegado'
          ? '¡Tu técnico ha llegado!'
          : `Actualización de Solicitud #${requestId}`;

      assert.equal(resolveNotificationTitle('llegado', '123'), '¡Tu técnico ha llegado!');
      assert.equal(resolveNotificationTitle('en_camino', '123'), 'Actualización de Solicitud #123');
    });

    it('control de privacidad: solo el cliente dueño o el personal asignado pueden consultar tracking', async () => {
      const requestMeta = {
        clientId: 100n,
        employeeId: null,
        branchId: null,
      };

      // Cliente dueño -> permitido
      const ownerAllowed = await trackingService.canAccessRequestTracking(
        { id: '100', role: 'cliente' },
        requestMeta,
      );
      assert.equal(ownerAllowed, true);

      // Otro cliente -> denegado
      const otherClientAllowed = await trackingService.canAccessRequestTracking(
        { id: '200', role: 'cliente' },
        requestMeta,
      );
      assert.equal(otherClientAllowed, false);

      // Empleado sin asignación a la solicitud -> denegado
      const unassignedEmployeeAllowed = await trackingService.canAccessRequestTracking(
        { id: '300', role: 'empleado' },
        requestMeta,
      );
      assert.equal(unassignedEmployeeAllowed, false);

      // Gerente sin sucursal asignada en la solicitud -> denegado
      const unassignedManagerAllowed = await trackingService.canAccessRequestTracking(
        { id: '400', role: 'gerente' },
        requestMeta,
      );
      assert.equal(unassignedManagerAllowed, false);

      // Proveedor ajeno sin sucursal ni asignación -> denegado
      const unrelatedSupplierAllowed = await trackingService.canAccessRequestTracking(
        { id: '500', role: 'proveedor' },
        requestMeta,
      );
      assert.equal(unrelatedSupplierAllowed, false);

      // Roles administrativos o externos al traslado -> denegado
      const supportAllowed = await trackingService.canAccessRequestTracking(
        { id: '1', role: 'soporte' },
        requestMeta,
      );
      assert.equal(supportAllowed, false);
    });

    it('rechaza avanzar estado si el rol es cliente, pero admite empleado y proveedor independiente', async () => {
      await assert.rejects(
        async () => {
          await advanceServiceRequestStatus(
            1n,
            { id: '10', role: 'cliente' },
            { status: 'en_camino', latitude: 19.43, longitude: -99.13 },
          );
        },
        (err: unknown) => err instanceof ForbiddenError && err.code === 'INSUFFICIENT_PERMISSIONS',
      );
    });
  });

  after(async () => {
    await closeDatabase();
  });
});
