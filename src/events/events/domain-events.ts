import crypto from 'node:crypto';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';

export const DOMAIN_EVENTS = {
  SERVICE_REQUEST_STATUS_CHANGED: 'service_request.status_changed',
  SERVICE_REQUEST_DISPATCHED: 'service_request.dispatched',
  SERVICE_REQUEST_REJECTED: 'service_request.rejected',
  PRICE_ADJUSTMENT_PROPOSED: 'price_adjustment.proposed',
  PRICE_ADJUSTMENT_RESPONDED: 'price_adjustment.responded',
  PAYMENT_REGISTERED: 'payment.registered',
  PAYMENT_RESPONDED: 'payment.responded',
  DEBT_REMINDER: 'payment.debt_reminder',
  REPORT_STATUS_CHANGED: 'report.status_changed',
  SUPPLIER_VERIFICATION_CHANGED: 'supplier.verification_changed',
  SUPPLIER_APPLICATION_RESOLVED: 'supplier.application_resolved',
  SUPPLIER_APPLICATION_CREATED: 'supplier.application_created',
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
  branchId: string | null;
  latitude?: number | null;
  longitude?: number | null;
  reason?: string | null;
  /** La transacción de dominio ya insertó service_request_events. */
  historyPersisted?: boolean;
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
// 1.1 Despacho de solicitud de emergencia (API-28)
// ---------------------------------------------------------------------------

export interface ServiceRequestDispatchedPayload {
  requestId: string;
  categoryId: string;
  categoryName: string;
  latitude: number;
  longitude: number;
  recipientUserIds: string[];
  employeeIds: string[];
  radiusKm: number;
}

export class ServiceRequestDispatchedEvent extends BaseDomainEvent<ServiceRequestDispatchedPayload> {
  constructor(payload: ServiceRequestDispatchedPayload, eventId?: string, occurredOn?: Date) {
    super(
      DOMAIN_EVENTS.SERVICE_REQUEST_DISPATCHED,
      payload.requestId,
      payload,
      eventId,
      occurredOn,
    );
  }
}

export interface ServiceRequestRejectedPayload {
  requestId: string;
  clientId: string;
  employeeIds: string[];
  reason: string;
  isEmergency: boolean;
}

export class ServiceRequestRejectedEvent extends BaseDomainEvent<ServiceRequestRejectedPayload> {
  constructor(payload: ServiceRequestRejectedPayload, eventId?: string, occurredOn?: Date) {
    super(DOMAIN_EVENTS.SERVICE_REQUEST_REJECTED, payload.requestId, payload, eventId, occurredOn);
  }
}

// ---------------------------------------------------------------------------
// 1.2 Ajustes de precio (API-36)
// ---------------------------------------------------------------------------

export interface PriceAdjustmentProposedPayload {
  requestId: string;
  adjustmentId: string;
  clientId: string;
  employeeId: string | null;
  amount: string;
  reason: string;
  description: string | null;
}

/** El técnico propone cobrar más; el cliente debe aprobarlo o rechazarlo. */
export class PriceAdjustmentProposedEvent extends BaseDomainEvent<PriceAdjustmentProposedPayload> {
  constructor(payload: PriceAdjustmentProposedPayload, eventId?: string, occurredOn?: Date) {
    super(DOMAIN_EVENTS.PRICE_ADJUSTMENT_PROPOSED, payload.requestId, payload, eventId, occurredOn);
  }
}

export interface PriceAdjustmentRespondedPayload {
  requestId: string;
  adjustmentId: string;
  clientId: string;
  employeeId: string | null;
  /** Cuentas a las que se avisa: el técnico asignado. */
  technicianUserIds: string[];
  amount: string;
  decision: 'aprobado' | 'rechazado';
}

export class PriceAdjustmentRespondedEvent extends BaseDomainEvent<PriceAdjustmentRespondedPayload> {
  constructor(payload: PriceAdjustmentRespondedPayload, eventId?: string, occurredOn?: Date) {
    super(
      DOMAIN_EVENTS.PRICE_ADJUSTMENT_RESPONDED,
      payload.requestId,
      payload,
      eventId,
      occurredOn,
    );
  }
}

// ---------------------------------------------------------------------------
// 1.3 Pagos y adeudos (API-37)
// ---------------------------------------------------------------------------

export interface PaymentRegisteredPayload {
  requestId: string;
  paymentId: string;
  clientId: string;
  employeeId: string | null;
  /** Del lado del proveedor: quién debe confirmar que lo recibió. */
  providerUserIds: string[];
  amount: string;
  method: string;
}

/** El cliente dice que pagó; el proveedor debe confirmar que lo recibió. */
export class PaymentRegisteredEvent extends BaseDomainEvent<PaymentRegisteredPayload> {
  constructor(payload: PaymentRegisteredPayload, eventId?: string, occurredOn?: Date) {
    super(DOMAIN_EVENTS.PAYMENT_REGISTERED, payload.requestId, payload, eventId, occurredOn);
  }
}

export interface PaymentRespondedPayload {
  requestId: string;
  paymentId: string;
  clientId: string;
  employeeId: string | null;
  branchId: string | null;
  amount: string;
  method: string;
  decision: 'completado' | 'fallido';
  reason: string | null;
  /** Lo que falta por pagar después de responder. */
  balanceDue: string;
}

/** El proveedor confirmó que recibió el pago, o dijo que no le llegó. */
export class PaymentRespondedEvent extends BaseDomainEvent<PaymentRespondedPayload> {
  constructor(payload: PaymentRespondedPayload, eventId?: string, occurredOn?: Date) {
    super(DOMAIN_EVENTS.PAYMENT_RESPONDED, payload.requestId, payload, eventId, occurredOn);
  }
}

export interface DebtReminderPayload {
  requestId: string;
  clientId: string;
  balanceDue: string;
}

/** Recordatorio diario al cliente de un servicio terminado que no ha pagado. */
export class DebtReminderEvent extends BaseDomainEvent<DebtReminderPayload> {
  constructor(payload: DebtReminderPayload, eventId?: string, occurredOn?: Date) {
    super(DOMAIN_EVENTS.DEBT_REMINDER, payload.requestId, payload, eventId, occurredOn);
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
  documentName?: string | null;
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

// ---------------------------------------------------------------------------
// 4. Resolución administrativa de una solicitud de proveedor (API-13)
// ---------------------------------------------------------------------------

export interface SupplierApplicationResolvedPayload {
  applicationId: string;
  supplierId: string;
  userId: string;
  email: string;
  managerName: string;
  businessName: string;
  state: 'aprobada' | 'rechazada' | 'documentacion_incompleta';
  comments?: string | null;
  missingDocuments?: string[];
  reviewedBy: string;
}

export class SupplierApplicationResolvedEvent extends BaseDomainEvent<SupplierApplicationResolvedPayload> {
  constructor(payload: SupplierApplicationResolvedPayload, eventId?: string, occurredOn?: Date) {
    super(
      DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED,
      payload.applicationId,
      payload,
      eventId,
      occurredOn,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Nueva solicitud de proveedor (API-25)
// ---------------------------------------------------------------------------

export interface SupplierApplicationCreatedPayload {
  applicationId: string;
  supplierId: string;
  userId: string;
  businessName: string;
  supplierType: string;
}

export class SupplierApplicationCreatedEvent extends BaseDomainEvent<SupplierApplicationCreatedPayload> {
  constructor(payload: SupplierApplicationCreatedPayload, eventId?: string, occurredOn?: Date) {
    super(
      DOMAIN_EVENTS.SUPPLIER_APPLICATION_CREATED,
      payload.applicationId,
      payload,
      eventId,
      occurredOn,
    );
  }
}
