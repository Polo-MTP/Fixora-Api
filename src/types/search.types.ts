export type SearchSortOption = 'recomendado' | 'distancia' | 'calificacion' | 'precio';

export interface SearchBranchesQuery {
  lat: number;
  lng: number;
  radius_km?: number;
  category_id?: string;
  sort?: SearchSortOption;
  available_now?: boolean;
  page?: number;
  limit?: number;
}

export interface BranchSearchResultItem {
  id: string;
  name: string;
  business_name: string;
  supplier_type: 'independiente' | 'empresa';
  logo_url: string | null;
  latitude: number;
  longitude: number;
  distance_km: number;
  rating_avg: number;
  reviews_count: number;
  base_price: string | null;
  open_now: boolean;
}

export interface PaginationResponse {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface SearchBranchesResult {
  data: BranchSearchResultItem[];
  pagination: PaginationResponse;
}
