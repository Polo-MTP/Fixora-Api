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

export interface RouteEta {
  duration_seconds: number;
  distance_meters: number;
  eta_timestamp: string;
  polyline: string | null;
  last_calculated_at: number;
  last_technician_lat: number;
  last_technician_lng: number;
  is_fallback: boolean;
}

export interface RequestTrackingData {
  requestId: string;
  status: string;
  technician_location: StoredTechnicianLocation | null;
  route_eta: {
    duration_seconds: number;
    distance_meters: number;
    eta_timestamp: string;
    polyline: string | null;
    is_fallback: boolean;
  } | null;
}
