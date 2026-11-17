import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import {
  DOMAIN_EVENTS,
  type ServiceRequestStatusChangedPayload,
  type ReportStatusChangedPayload,
  type SupplierVerificationPayload,
  type SupplierApplicationResolvedPayload,
} from '../events/domain-events.ts';

export interface RealTimeMessage {
  channel: string;
  event: string;
  data: unknown;
  timestamp: Date;
}

export type RealTimePublisher = (message: RealTimeMessage) => Promise<void> | void;

export class RealTimeObserver implements Observer<DomainEvent> {
  public readonly name = 'RealTimeObserver';
  private readonly publisher: RealTimePublisher;
  private readonly publishedMessages: RealTimeMessage[] = [];

  constructor(customPublisher?: RealTimePublisher) {
    this.publisher = customPublisher ?? this.defaultConsolePublisher;
  }

  private defaultConsolePublisher(_message: RealTimeMessage): void {
    // Implementación por defecto desacoplada (se integra con WebSockets o Redis Pub/Sub)
    // En producción emite al bus de tiempo real
  }

  public async handle(event: DomainEvent): Promise<void> {
    const timestamp = event.occurredOn;

    switch (event.eventType) {
      case DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED: {
        const payload = event.payload as ServiceRequestStatusChangedPayload;

        const channels = [`requests:${payload.requestId}`, `users:${payload.clientId}`];

        if (payload.employeeId) {
          channels.push(`technicians:${payload.employeeId}`);
        }

        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'service_request_updated',
            data: {
              requestId: payload.requestId,
              status: payload.toStatus,
              previousStatus: payload.fromStatus,
              latitude: payload.latitude,
              longitude: payload.longitude,
            },
            timestamp,
          });
        }
        break;
      }

      case DOMAIN_EVENTS.REPORT_STATUS_CHANGED: {
        const payload = event.payload as ReportStatusChangedPayload;

        const channels = [
          `reports:${payload.reportId}`,
          `users:${payload.reporterId}`,
          'admin:reports',
        ];

        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'report_updated',
            data: {
              reportId: payload.reportId,
              status: payload.toStatus,
              resolutionType: payload.resolutionType,
            },
            timestamp,
          });
        }
        break;
      }

      case DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED: {
        const payload = event.payload as SupplierApplicationResolvedPayload;
        const channels = [`users:${payload.userId}`, 'admin:verifications'];
        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'supplier_application_resolved',
            data: { applicationId: payload.applicationId, state: payload.state },
            timestamp,
          });
        }
        break;
      }

      case DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED: {
        const payload = event.payload as SupplierVerificationPayload;

        const channels = [`users:${payload.userId}`, 'admin:verifications'];

        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'verification_updated',
            data: {
              supplierId: payload.supplierId,
              userId: payload.userId,
              result: payload.result,
              comment: payload.comment,
            },
            timestamp,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private async emitMessage(message: RealTimeMessage): Promise<void> {
    this.publishedMessages.push(message);
    await Promise.resolve(this.publisher(message));
  }

  public getPublishedMessages(): ReadonlyArray<RealTimeMessage> {
    return this.publishedMessages;
  }

  public getMessagesForChannel(channel: string): RealTimeMessage[] {
    return this.publishedMessages.filter((m) => m.channel === channel);
  }

  public clearMessages(): void {
    this.publishedMessages.length = 0;
  }
}
