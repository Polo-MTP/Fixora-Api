export interface TechnicianAvailabilityInput {
  online: boolean;
  latitude?: number;
  longitude?: number;
}

export interface TechnicianLocation {
  latitude: number;
  longitude: number;
}

export interface TechnicianAvailabilityResponse {
  employee_id: string;
  user_id: string;
  branch_id: string;
  online: boolean;
  location: TechnicianLocation | null;
  branch: {
    id: string;
    accepting_request: boolean;
    is_open: boolean;
    current_time?: string;
  };
  expires_in_seconds: number;
  updated_at: string | null;
}

export interface ScheduleCheckResult {
  isOpen: boolean;
  reason?: 'NOT_ACCEPTING_REQUESTS' | 'NO_SCHEDULE_TODAY' | 'OUTSIDE_HOURS';
  message?: string;
  currentDayOfWeek?: number;
  currentTime?: string;
}
