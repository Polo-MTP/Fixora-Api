import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import {
  DOMAIN_EVENTS,
  type ServiceRequestStatusChangedPayload,
  type ReportStatusChangedPayload,
  type SupplierVerificationPayload,
} from '../events/domain-events.ts';
import { db } from '../../config/database.ts';
import {
  service_request_events,
  reports_events,
  document_validations,
} from '../../database/schema/tables.ts';
import type { serviceRequestStatusEnum, reportStatusEnum } from '../../database/schema/enums.ts';

export interface HistoryEntry {
  category: 'service_request' | 'report' | 'supplier_verification';
  aggregateId: string;
  fromStatus?: string | null;
  toStatus: string;
  changedBy: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

export type HistoryPersister = (entry: HistoryEntry) => Promise<void>;

export class HistoryObserver implements Observer<DomainEvent> {
  public readonly name = 'HistoryObserver';
  private readonly persister: HistoryPersister;

  constructor(customPersister?: HistoryPersister) {
    this.persister = customPersister ?? this.defaultDatabasePersister;
  }

  // Si falla, el error llega al EventBus: lo registra y lo cuenta como fallo de este observador
  // sin afectar a los demás. Tragárselo aquí haría que el bus lo reportara como éxito.
  private async defaultDatabasePersister(entry: HistoryEntry): Promise<void> {
    if (entry.category === 'service_request') {
      type RequestStatus = (typeof serviceRequestStatusEnum.enumValues)[number];
      await db.insert(service_request_events).values({
        request_id: BigInt(entry.aggregateId),
        from_status: (entry.fromStatus as unknown as RequestStatus) ?? null,
        to_status: entry.toStatus as unknown as RequestStatus,
        changed_by: BigInt(entry.changedBy),
        latitude: entry.details?.latitude != null ? String(entry.details.latitude) : null,
        longitude: entry.details?.longitude != null ? String(entry.details.longitude) : null,
      });
    } else if (entry.category === 'report') {
      type ReportStatus = (typeof reportStatusEnum.enumValues)[number];
      await db.insert(reports_events).values({
        report_id: BigInt(entry.aggregateId),
        author_id: BigInt(entry.changedBy),
        type: 'cambio_estado',
        body: (entry.details?.comment as string) ?? `Cambio de estado a ${entry.toStatus}`,
        from_status: (entry.fromStatus as unknown as ReportStatus) ?? null,
        to_status: entry.toStatus as unknown as ReportStatus,
      });
    } else if (entry.category === 'supplier_verification') {
      const docId = entry.details?.documentId;
      if (docId) {
        await db.insert(document_validations).values({
          document_id: BigInt(String(docId)),
          result: entry.toStatus,
          reviewed_by: BigInt(entry.changedBy),
          comment: (entry.details?.comment as string) ?? null,
        });
      }
    }
  }

  public async handle(event: DomainEvent): Promise<void> {
    switch (event.eventType) {
      case DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED: {
        const payload = event.payload as ServiceRequestStatusChangedPayload;
        const entry: HistoryEntry = {
          category: 'service_request',
          aggregateId: payload.requestId,
          fromStatus: payload.fromStatus,
          toStatus: payload.toStatus,
          changedBy: payload.changedBy,
          details: {
            branchId: payload.branchId,
            clientId: payload.clientId,
            employeeId: payload.employeeId,
            latitude: payload.latitude,
            longitude: payload.longitude,
            reason: payload.reason,
          },
          createdAt: event.occurredOn,
        };
        await this.persister(entry);
        break;
      }
      case DOMAIN_EVENTS.REPORT_STATUS_CHANGED: {
        const payload = event.payload as ReportStatusChangedPayload;
        const entry: HistoryEntry = {
          category: 'report',
          aggregateId: payload.reportId,
          fromStatus: payload.fromStatus,
          toStatus: payload.toStatus,
          changedBy: payload.changedBy,
          details: {
            category: payload.category,
            reporterId: payload.reporterId,
            resolutionType: payload.resolutionType,
            comment: payload.comment,
          },
          createdAt: event.occurredOn,
        };
        await this.persister(entry);
        break;
      }
      case DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED: {
        const payload = event.payload as SupplierVerificationPayload;
        const entry: HistoryEntry = {
          category: 'supplier_verification',
          aggregateId: payload.supplierId,
          fromStatus: null,
          toStatus: payload.result,
          changedBy: payload.reviewedBy,
          details: {
            documentId: payload.documentId,
            userId: payload.userId,
            comment: payload.comment,
            supplierType: payload.supplierType,
          },
          createdAt: event.occurredOn,
        };
        await this.persister(entry);
        break;
      }
      default:
        break;
    }
  }
}
