import crypto from 'node:crypto';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';

export const DOMAIN_EVENTS = {
  SERVICE_REQUEST_STATUS_CHANGED: 'service_request.status_changed',
  REPORT_STATUS_CHANGED: 'report.status_changed',
  SUPPLIER_VERIFICATION_CHANGED: 'supplier.verification_changed',
} as const;

export abstract class BaseDomainEvent<T> implements DomainEvent<T> {
  public readonly eventId: string;
  public readonly occurredOn: Date;
  public readonly eventType: string;
  public readonly aggregateId: string;
  public readonly payload: T;

  constructor(
    eventType: string,
    aggregateId: string,
    payload: T,
    eventId?: string,
    occurredOn?: Date,
  ) {
    this.eventType = eventType;
    this.aggregateId = aggregateId;
    this.payload = payload;
    this.eventId = eventId ?? crypto.randomUUID();
    this.occurredOn = occurredOn ?? new Date();
  }
}

// ---------------------------------------------------------------------------
// 1. Evento de Cambio de Estado en Solicitud de Servicio (Módulo 5)
// ---------------------------------------------------------------------------

export interface ServiceRequestStatusChangedPayload {
  requestId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  clientId: string;
  employeeId?: string | null;
  branchId: string;
  latitude?: number | null;
  longitude?: number | null;
  reason?: string | null;
}

export class ServiceRequestStatusChangedEvent extends BaseDomainEvent<ServiceRequestStatusChangedPayload> {
  constructor(payload: ServiceRequestStatusChangedPayload, eventId?: string, occurredOn?: Date) {
    super(
      DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED,
      payload.requestId,
      payload,
      eventId,
      occurredOn,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Evento de Cambio de Estado o Resolución en Reportes (Módulo 7)
// ---------------------------------------------------------------------------

export interface ReportStatusChangedPayload {
  reportId: string;
  reporterId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  category: string;
  resolutionType?: string | null;
  comment?: string | null;
}

export class ReportStatusChangedEvent extends BaseDomainEvent<ReportStatusChangedPayload> {
  constructor(payload: ReportStatusChangedPayload, eventId?: string, occurredOn?: Date) {
    super(DOMAIN_EVENTS.REPORT_STATUS_CHANGED, payload.reportId, payload, eventId, occurredOn);
  }
}

// ---------------------------------------------------------------------------
// 3. Evento de Verificación de Proveedor / Documento (Módulos 1 y 4)
// ---------------------------------------------------------------------------

export interface SupplierVerificationPayload {
  supplierId: string;
  userId: string;
  documentId?: string | null;
  result: 'aprobado' | 'rechazado' | 'pendiente';
  reviewedBy: string;
  comment?: string | null;
  supplierType?: string | null;
}

export class SupplierVerificationEvent extends BaseDomainEvent<SupplierVerificationPayload> {
  constructor(payload: SupplierVerificationPayload, eventId?: string, occurredOn?: Date) {
    super(
      DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED,
      payload.supplierId,
      payload,
      eventId,
      occurredOn,
    );
  }
}
