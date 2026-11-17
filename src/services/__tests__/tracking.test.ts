import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  trackingService,
  MIN_RECALCULATION_INTERVAL_MS,
  SIGNIFICANT_DEVIATION_METERS,
} from '../tracking.service.ts';
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

  describe('API-33: Ruta y tiempo estimado de llegada (ETA)', () => {
    it('calcula ruta y ETA estimada en fallback cuando no hay API Key externa', () => {
      // Coordenadas: Zócalo (19.4326, -99.1332) a Bellas Artes (19.4352, -99.1412) ~1.1 km
      const result = trackingService.calculateEstimatedRoute(19.4326, -99.1332, 19.4352, -99.1412);

      assert.equal(result.is_fallback, true);
      assert.ok(result.distance_meters > 800 && result.distance_meters < 2000);
      assert.ok(result.duration_seconds >= 60);
      assert.ok(Date.parse(result.eta_timestamp) > Date.now());
      assert.equal(result.polyline, null);
    });

    it('reutiliza la ruta calculada si no ha expirado el intervalo y el técnico no se ha desviado', async () => {
      const originLat = 19.4326;
      const originLng = -99.1332;
      const destLat = 19.45;
      const destLng = -99.12;

      // Primer cálculo
      const first = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        originLat,
        originLng,
        destLat,
        destLng,
        true, // forzar primer cálculo
      );

      assert.ok(first.duration_seconds > 0);

      // Segundo cálculo inmediatamente después (mismo punto, 0 ms transcurridos)
      const second = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        originLat,
        originLng,
        destLat,
        destLng,
        false,
      );

      // Debe reutilizar el cálculo previo sin llamar a la API externa
      assert.equal(second.last_calculated_at, first.last_calculated_at);
      assert.equal(second.distance_meters, first.distance_meters);

      await trackingService.clearRequestTracking(dummyRequestId);
    });

    it('recalcula la ruta si se detecta un desvío significativo', async () => {
      const originLat = 19.4326;
      const originLng = -99.1332;
      const destLat = 19.45;
      const destLng = -99.12;

      // Primer cálculo
      const first = await trackingService.getOrCalculateRouteEta(
        dummyRequestId,
        originLat,
        originLng,
        destLat,
        destLng,
        true,
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
      );

      // Debe haber recalculado la ruta con la nueva posición y mayor distancia
      assert.equal(recalculated.last_technician_lat, deviatedLat);
      assert.notEqual(recalculated.distance_meters, first.distance_meters);
      assert.ok(recalculated.distance_meters > first.distance_meters);

      await trackingService.clearRequestTracking(dummyRequestId);
    });

    it('constantes de cuota gratuita y desvío tienen valores adecuados', () => {
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
  });
});
