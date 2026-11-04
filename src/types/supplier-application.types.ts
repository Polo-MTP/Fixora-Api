export type SupplierType = 'independiente' | 'empresa';

export interface ManagerInput {
  email: string;
  password: string;
  name: string;
  lastname_p: string;
  lastname_m?: string | null;
  birth_date?: string | null;
  phone?: string | null;
}

export interface BusinessInput {
  name: string;
  tax_identification?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface AddressInput {
  street: string;
  num_ext: string;
  num_int?: string | null;
  colony: string;
  municipality: string;
  state: string;
  postal_code: string;
  country?: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
  reference?: string | null;
}

export interface ScheduleInput {
  day_of_week: number; // 0 = domingo ... 6 = sábado
  open_time: string; // HH:MM o HH:MM:SS
  close_time: string; // HH:MM o HH:MM:SS
}

export interface BranchCategoryInput {
  category_id: string | number | bigint;
  base_price: string | number;
  duration_minutes?: number;
}

export interface EmployeeInput {
  email: string;
  password: string;
  name: string;
  lastname_p: string;
  lastname_m?: string | null;
  phone?: string | null;
  role: 'gerente' | 'empleado';
  can_attend?: boolean;
}

export interface BranchInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
  address: AddressInput;
  schedules: ScheduleInput[];
  categories: BranchCategoryInput[];
  employees?: EmployeeInput[];
  manager_is_owner?: boolean;
}

export interface SupplierDocumentInput {
  type_document_id: string | number | bigint;
  file_key: string;
  file_hash?: string | null;
  due_date?: string | null;
}

export interface CreateSupplierApplicationInput {
  manager: ManagerInput;
  supplier_type: SupplierType;
  rfc?: string | null;
  business: BusinessInput;
  branches: BranchInput[];
  documents?: SupplierDocumentInput[];
  comments?: string | null;
}

export interface SupplierApplicationResult {
  id: string;
  supplier_id: string;
  supplier_type: SupplierType;
  state: string;
  application_date: string;
  due_date: string | null;
  business_name: string;
  manager_name: string;
  email: string;
  branches_count: number;
  documents_count: number;
}
