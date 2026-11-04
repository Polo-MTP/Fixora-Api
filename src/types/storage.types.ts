export type FileCategory = 'documents' | 'photos' | 'evidences';

export interface CategoryValidationConfig {
  label: string;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  maxSizeBytes: number;
}

export const STORAGE_RULES: Record<FileCategory, CategoryValidationConfig> = {
  documents: {
    label: 'Documentos y Verificación',
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png', '.webp'],
    maxSizeBytes: 10 * 1024 * 1024, // 10 MB
  },
  photos: {
    label: 'Fotografías y Logotipos',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
    maxSizeBytes: 5 * 1024 * 1024, // 5 MB
  },
  evidences: {
    label: 'Evidencias de Servicios y Reportes',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4'],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.mp4'],
    maxSizeBytes: 25 * 1024 * 1024, // 25 MB
  },
};

export interface UploadedFileResult {
  file_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  file_hash: string;
  category: FileCategory;
  is_verification: boolean;
  uploaded_at: string;
}

export interface SignedUrlOptions {
  file_key: string;
  expires_in_minutes?: number;
  disposition?: 'inline' | 'attachment';
  download_name?: string;
}

export interface SignedUrlResult {
  file_key: string;
  signed_url: string;
  expires_at: string;
  expires_in_seconds: number;
}

export interface VerifiedSignaturePayload {
  file_key: string;
  expires: number;
  disposition: 'inline' | 'attachment';
  isAdminDoc: boolean;
}
