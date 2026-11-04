import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import {
  DOMAIN_EVENTS,
  type ServiceRequestStatusChangedPayload,
  type ReportStatusChangedPayload,
  type SupplierVerificationPayload,
} from '../events/domain-events.ts';
import { db } from '../../config/database.ts';
import { notifications } from '../../database/schema/tables.ts';

export interface NotificationRecord {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export type NotificationPersister = (record: NotificationRecord) => Promise<void>;

export class NotificationObserver implements Observer<DomainEvent> {
  public readonly name = 'NotificationObserver';
  private readonly persister: NotificationPersister;
  private readonly dispatchedRecords: NotificationRecord[] = [];

  constructor(customPersister?: NotificationPersister) {
    this.persister = customPersister ?? this.defaultDatabasePersister;
  }

  private async defaultDatabasePersister(record: NotificationRecord): Promise<void> {
    try {
      await db.insert(notifications).values({
        user_id: BigInt(record.userId),
        type: record.type,
        title: record.title,
        message: record.message,
        entity_type: record.entityType,
        entity_id: record.entityId ? BigInt(record.entityId) : null,
      });
    } catch (error) {
      console.warn('[NotificationObserver] No se pudo guardar la notificación en BD:', error);
    }
  }

  public async handle(event: DomainEvent): Promise<void> {
    switch (event.eventType) {
      case DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED: {
        const payload = event.payload as ServiceRequestStatusChangedPayload;
        await this.handleServiceRequest(payload);
        break;
      }
      case DOMAIN_EVENTS.REPORT_STATUS_CHANGED: {
        const payload = event.payload as ReportStatusChangedPayload;
        await this.handleReport(payload);
        break;
      }
      case DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED: {
        const payload = event.payload as SupplierVerificationPayload;
        await this.handleSupplierVerification(payload);
        break;
      }
      default:
        // Evento no procesado por este observador
        break;
    }
  }

  private async handleServiceRequest(payload: ServiceRequestStatusChangedPayload): Promise<void> {
    const { requestId, toStatus, clientId, reason } = payload;
    let message = `El estado de tu solicitud cambió a "${toStatus}".`;

    if (toStatus === 'aceptada') {
      message = '¡Un profesional ha aceptado tu solicitud de servicio!';
    } else if (toStatus === 'en_curso') {
      message = 'El técnico está en camino o atendiendo tu servicio en tu domicilio.';
    } else if (toStatus === 'completada') {
      message = 'Tu servicio ha sido marcado como completado. ¡No olvides calificar la atención!';
    } else if (toStatus === 'cancelada') {
      message = `Tu solicitud fue cancelada${reason ? ': ' + reason : '.'}`;
    }

    const record: NotificationRecord = {
      userId: clientId,
      type: 'solicitud_servicio',
      title: `Actualización de Solicitud #${requestId}`,
      message,
      entityType: 'service_request',
      entityId: requestId,
    };

    this.dispatchedRecords.push(record);
    await this.persister(record);
  }

  private async handleReport(payload: ReportStatusChangedPayload): Promise<void> {
    const { reportId, reporterId, toStatus, resolutionType } = payload;
    let message = `Tu reporte #${reportId} ha cambiado de estado a "${toStatus}".`;

    if (toStatus === 'resuelto') {
      message = `Tu reporte #${reportId} ha sido resuelto${resolutionType ? ' (' + resolutionType + ')' : ''}.`;
    }

    const record: NotificationRecord = {
      userId: reporterId,
      type: 'reporte',
      title: `Actualización de Reporte #${reportId}`,
      message,
      entityType: 'report',
      entityId: reportId,
    };

    this.dispatchedRecords.push(record);
    await this.persister(record);
  }

  private async handleSupplierVerification(payload: SupplierVerificationPayload): Promise<void> {
    const { supplierId, userId, result, comment } = payload;
    const isApproved = result === 'aprobado';
    const message = isApproved
      ? '¡Felicidades! Tus documentos de proveedor han sido aprobados. Tu cuenta está habilitada.'
      : `Tu verificación de documentos fue rechazada${comment ? ': ' + comment : '.'}`;

    const record: NotificationRecord = {
      userId,
      type: 'verificacion_proveedor',
      title: isApproved ? 'Verificación Aprobada' : 'Verificación Rechazada',
      message,
      entityType: 'supplier_verification',
      entityId: supplierId,
    };

    this.dispatchedRecords.push(record);
    await this.persister(record);
  }

  public getDispatchedRecords(): ReadonlyArray<NotificationRecord> {
    return this.dispatchedRecords;
  }

  public clearRecords(): void {
    this.dispatchedRecords.length = 0;
  }
}
