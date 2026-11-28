import { BadRequestError } from '../errors/app-error.ts';

/**
 * API-47: cómo se eligen los servicios recomendados para la pantalla principal del cliente, sin
 * base de datos para probarlo solo. Cada candidato es una pareja sucursal-servicio ya ordenada por
 * el algoritmo de emparejamiento (API-24).
 */

export const DEFAULT_RECOMMENDATIONS = 8;
export const MAX_RECOMMENDATIONS = 20;
export const DEFAULT_RADIUS_KM = 10;

export interface RankedPair {
  branchId: string;
  categoryId: string;
  matchScore: number;
}

/**
 * Toma los mejores sin repetir negocio. Primero uno por servicio, para que la pantalla no sean
 * ocho plomeros; si faltan, completa con los mejores restantes aunque repitan servicio.
 */
export function pickRecommendations<T extends RankedPair>(ranked: T[], limit: number): T[] {
  const picked: T[] = [];
  const usedBranches = new Set<string>();
  const usedCategories = new Set<string>();

  for (const pair of ranked) {
    if (picked.length >= limit) break;
    if (usedBranches.has(pair.branchId) || usedCategories.has(pair.categoryId)) continue;
    picked.push(pair);
    usedBranches.add(pair.branchId);
    usedCategories.add(pair.categoryId);
  }
  for (const pair of ranked) {
    if (picked.length >= limit) break;
    if (usedBranches.has(pair.branchId)) continue;
    picked.push(pair);
    usedBranches.add(pair.branchId);
  }
  // Se muestran en el orden del emparejamiento, no en el de las dos pasadas.
  return picked.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
}

export interface RecommendationsQuery {
  lat?: unknown;
  lng?: unknown;
  radius_km?: unknown;
  limit?: unknown;
}

/** Coordenadas del cliente, radio de 1 a 50 km y cuántos (1 a 20). */
export function parseRecommendationsQuery(query: RecommendationsQuery) {
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  if (
    query.lat === undefined ||
    query.lat === '' ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90
  ) {
    throw new BadRequestError(
      'lat es obligatorio y debe estar entre -90 y 90.',
      'VALIDATION_ERROR',
    );
  }
  if (
    query.lng === undefined ||
    query.lng === '' ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw new BadRequestError(
      'lng es obligatorio y debe estar entre -180 y 180.',
      'VALIDATION_ERROR',
    );
  }
  const radiusKm = query.radius_km === undefined ? DEFAULT_RADIUS_KM : Number(query.radius_km);
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 50) {
    throw new BadRequestError('radius_km debe estar entre 1 y 50.', 'VALIDATION_ERROR');
  }
  const limit = query.limit === undefined ? DEFAULT_RECOMMENDATIONS : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECOMMENDATIONS) {
    throw new BadRequestError(
      `limit debe ser un entero de 1 a ${MAX_RECOMMENDATIONS}.`,
      'VALIDATION_ERROR',
    );
  }
  return { lat, lng, radiusKm, limit };
}
