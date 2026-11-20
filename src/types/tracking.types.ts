export interface TechnicianLocationUpdate {
  latitude: number;
  longitude: number;
  heading?: number | null;
  speed?: number | null;
  timestamp?: string;
}

export interface StoredTechnicianLocation {
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  updated_at: string;
}

/** Geometría GeoJSON LineString nativa para capas de ruta en MapLibre GL ([lng, lat]). */
export interface RouteLineStringGeometry {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface RouteEta {
  duration_seconds: number;
  distance_meters: number;
  eta_timestamp: string;
  polyline: string | null;
  geometry: RouteLineStringGeometry | null;
  last_calculated_at: number;
  last_technician_lat: number;
  last_technician_lng: number;
  is_fallback: boolean;
}

export interface RequestTrackingData {
  requestId: string;
  status: string;
  map_style_url: string;
  technician_location: StoredTechnicianLocation | null;
  route_eta: {
    duration_seconds: number;
    distance_meters: number;
    eta_timestamp: string;
    polyline: string | null;
    geometry: RouteLineStringGeometry | null;
    is_fallback: boolean;
  } | null;
}
