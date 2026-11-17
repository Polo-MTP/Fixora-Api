export interface MatchingCandidate {
  id: string;
  employee_id?: string;
  name: string;
  business_name: string;
  supplier_type: 'independiente' | 'empresa';
  latitude: number;
  longitude: number;
  distance_km: number;
  open_now: boolean;
  is_online_in_redis?: boolean;
  rating_avg: number;
  reviews_count: number;
  base_price: string | null;
}

export interface MatchingScoreBreakdown {
  proximity_score: number;
  independent_bonus: number;
  availability_score: number;
  rating_score: number;
  price_score: number;
  total_score: number;
}

export interface RankedMatchingCandidate extends MatchingCandidate {
  match_score: number;
  breakdown: MatchingScoreBreakdown;
}

export interface MatchingOptions {
  clientLat: number;
  clientLng: number;
  radiusKm?: number;
  categoryId?: string;
  requireOnlineOnly?: boolean;
  now?: Date;
}

export interface EmergencyTechnicianCandidate {
  employee_id: string;
  user_id: string;
  branch_id: string;
  name: string;
  business_name: string;
  supplier_type: 'independiente' | 'empresa';
  phone: string | null;
  latitude: number;
  longitude: number;
  distance_km: number;
  rating_avg: number;
  reviews_count: number;
  base_price: string | null;
  match_score: number;
  breakdown: MatchingScoreBreakdown;
}
