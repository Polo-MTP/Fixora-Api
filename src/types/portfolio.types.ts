export interface PortfolioMediaInput {
  file_key: string;
  description?: string | null;
}

export interface PortfolioWorkInput {
  title: string;
  description?: string | null;
  media: PortfolioMediaInput[];
}

export interface PortfolioMediaResponse {
  id: string;
  file_key: string;
  url: string;
  description: string | null;
}

export interface PortfolioWorkResponse {
  id: string;
  branch_id: string;
  title: string;
  description: string | null;
  media: PortfolioMediaResponse[];
}

export interface BranchCategoryInput {
  category_id: string;
  base_price: string;
  duration_minutes?: number;
}

export interface BranchCategoryResponse {
  category_id: string;
  category_name: string;
  icon_key: string | null;
  base_price: string;
  duration_minutes: number;
}

export interface SupplierDocumentVisibilityInput {
  is_public: boolean;
}

export interface SupplierDocumentResponse {
  id: string;
  supplier_id: string;
  type_document_id: string;
  type_name: string;
  file_key: string;
  file_url?: string;
  upload_date: string;
  due_date: string | null;
  is_public: boolean;
  validation: {
    result: string;
    comment: string | null;
    reviewed_at: string;
  } | null;
}

export interface CertificateResponse {
  id: string;
  type_name: string;
  file_key: string;
  url: string;
}

export interface EmployeeProfileInput {
  photo_key?: string | null;
  bio?: string | null;
}

export interface EmployeeVehicleInput {
  plate: string;
  brand: string;
  model: string;
  color: string;
  active?: boolean;
}

export interface EmployeeVehicleResponse {
  id: string;
  employee_id: string;
  plate: string;
  brand: string;
  model: string;
  color: string;
  active: boolean;
}

export interface EmployeeProfileResponse {
  photo_key: string | null;
  photo_url: string | null;
  bio: string | null;
}

export interface EmployeeDetailResponse {
  id: string;
  user_id: string;
  branch_id: string;
  email: string;
  name: string;
  lastname_p: string;
  lastname_m: string | null;
  phone: string | null;
  role: string;
  can_attend: boolean;
  active: boolean;
  profile: EmployeeProfileResponse;
  vehicle: EmployeeVehicleResponse | null;
}

export interface BranchPublicLocation {
  colony: string;
  municipality: string;
  latitude: number | null;
  longitude: number | null;
}

export interface BranchScheduleResponse {
  day_of_week: number;
  open_time: string;
  close_time: string;
  active?: boolean;
}

export interface BranchReviewSummary {
  rating: number;
  comment: string | null;
  author_name: string;
  created_at?: string;
}

export interface BranchPublicProfileResponse {
  id: string;
  name: string;
  business_name: string;
  supplier_type: 'independiente' | 'empresa';
  description: string | null;
  logo_url: string | null;
  phone: string | null;
  is_verified: boolean;
  plates: string[];
  rating_avg: number;
  reviews_count: number;
  total_jobs: number;
  accepting_request: boolean;
  location: BranchPublicLocation;
  schedules: BranchScheduleResponse[];
  categories: BranchCategoryResponse[];
  portfolio: PortfolioWorkResponse[];
  certificates: CertificateResponse[];
  latest_reviews: BranchReviewSummary[];
}
