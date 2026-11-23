export interface BaseEmailOptions {
  email: string;
  name: string;
}

export interface PasswordResetEmailOptions {
  email: string;
  name: string;
  code?: string;
  resetLink?: string;
  expiresInMinutes?: number;
}

export interface SupplierApplicationReceivedEmailOptions {
  email: string;
  managerName: string;
  businessName: string;
  applicationId: string;
  supplierType?: string;
  applicationDate?: string;
}

export type SupplierVerificationStatus =
  'aprobada' | 'rechazada' | 'documentacion_incompleta' | 'aprobado' | 'rechazado';

export interface SupplierVerificationResultEmailOptions {
  email: string;
  managerName: string;
  businessName?: string;
  status: SupplierVerificationStatus;
  comments?: string;
  missingDocuments?: string[];
  portalUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailPayload {
  from?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type EmailSender = (payload: EmailPayload) => Promise<{ id?: string; error?: unknown }>;
