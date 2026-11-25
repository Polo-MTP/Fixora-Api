import { publishRealtimeMessage } from '../../realtime/websocket.server.ts';
import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import {
  DOMAIN_EVENTS,
  type ServiceRequestStatusChangedPayload,
  type ServiceRequestDispatchedPayload,
  type ServiceRequestRejectedPayload,
  type PriceAdjustmentProposedPayload,
  type PriceAdjustmentRespondedPayload,
  type PaymentRegisteredPayload,
  type PaymentRespondedPayload,
  type ReportStatusChangedPayload,
  type SupplierVerificationPayload,
  type SupplierApplicationResolvedPayload,
  type ChatMessageSentPayload,
  type ChatMessagesReadPayload,
  type ReportCommentAddedPayload,
} from '../events/domain-events.ts';

export interface RealTimeMessage {
  channel: string;
  event: string;
  data: unknown;
  timestamp: Date;
}

const MAX_RETAINED_MESSAGES = 500;

export type RealTimePublisher = (message: RealTimeMessage) => Promise<void> | void;

export class RealTimeObserver implements Observer<DomainEvent> {
  public readonly name = 'RealTimeObserver';
  private readonly publisher: RealTimePublisher;
  private readonly publishedMessages: RealTimeMessage[] = [];

  constructor(customPublisher?: RealTimePublisher) {
    this.publisher = customPublisher ?? publishRealtimeMessage;
  }

  public async handle(event: DomainEvent): Promise<void> {
    const timestamp = event.occurredOn;

    switch (event.eventType) {
      case DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED: {
        const payload = event.payload as ServiceRequestStatusChangedPayload;

        const channels = [`requests:${payload.requestId}`, `users:${payload.clientId}`];

        // Las solicitudes normales se publican en el canal de su sucursal.
        if (payload.fromStatus === null && payload.branchId) {
          channels.push(`branches:${payload.branchId}`);
        }

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

      case DOMAIN_EVENTS.SERVICE_REQUEST_REJECTED: {
        const payload = event.payload as ServiceRequestRejectedPayload;
        if (!payload.isEmergency) {
          await this.emitMessage({
            channel: `users:${payload.clientId}`,
            event: 'service_request_rejected',
            data: {
              requestId: payload.requestId,
              reason: payload.reason,
              canChooseAnotherSupplier: true,
            },
            timestamp,
          });
        }
        for (const employeeId of payload.employeeIds) {
          await this.emitMessage({
            channel: `technicians:${employeeId}`,
            event: 'service_request_rejection_recorded',
            data: { requestId: payload.requestId, isEmergency: payload.isEmergency },
            timestamp,
          });
        }
        break;
      }

      // Ajustes de precio (API-36): la pantalla del cliente y la del técnico se actualizan solas.
      case DOMAIN_EVENTS.PRICE_ADJUSTMENT_PROPOSED:
      case DOMAIN_EVENTS.PRICE_ADJUSTMENT_RESPONDED: {
        const payload = event.payload as
          PriceAdjustmentProposedPayload | PriceAdjustmentRespondedPayload;
        const channels = [`requests:${payload.requestId}`, `users:${payload.clientId}`];
        if (payload.employeeId) channels.push(`technicians:${payload.employeeId}`);
        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'price_adjustment_updated',
            data: {
              requestId: payload.requestId,
              adjustmentId: payload.adjustmentId,
              amount: payload.amount,
              status: 'decision' in payload ? payload.decision : 'pendiente',
            },
            timestamp,
          });
        }
        break;
      }

      // Pagos (API-37): las pantallas de cobro del cliente y del técnico se actualizan solas.
      case DOMAIN_EVENTS.PAYMENT_REGISTERED:
      case DOMAIN_EVENTS.PAYMENT_RESPONDED: {
        const payload = event.payload as PaymentRegisteredPayload | PaymentRespondedPayload;
        const channels = [`requests:${payload.requestId}`, `users:${payload.clientId}`];
        if (payload.employeeId) channels.push(`technicians:${payload.employeeId}`);
        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'payment_updated',
            data: {
              requestId: payload.requestId,
              paymentId: payload.paymentId,
              amount: payload.amount,
              status: 'decision' in payload ? payload.decision : 'pendiente',
              balanceDue: 'balanceDue' in payload ? payload.balanceDue : undefined,
            },
            timestamp,
          });
        }
        break;
      }

      case DOMAIN_EVENTS.SERVICE_REQUEST_DISPATCHED: {
        const payload = event.payload as ServiceRequestDispatchedPayload;
        await Promise.all(
          payload.recipientUserIds.map((userId) =>
            this.emitMessage({
              channel: `users:${userId}`,
              event: 'emergency_request_available',
              data: {
                requestId: payload.requestId,
                categoryId: payload.categoryId,
                categoryName: payload.categoryName,
                latitude: payload.latitude,
                longitude: payload.longitude,
                radiusKm: payload.radiusKm,
              },
              timestamp,
            }),
          ),
        );
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
              folio: payload.folio ?? null,
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

      case DOMAIN_EVENTS.CHAT_MESSAGE_SENT: {
        const payload = event.payload as ChatMessageSentPayload;

        // Sala del chat: quien lo tiene abierto recibe el mensaje completo.
        await this.emitMessage({
          channel: `chats:${payload.requestId}`,
          event: 'chat_message',
          data: payload.message,
          timestamp,
        });

        // Sala personal del destinatario: contador de no leídos aunque no tenga el chat abierto.
        for (const userId of payload.recipientUserIds) {
          await this.emitMessage({
            channel: `users:${userId}`,
            event: 'chat_unread',
            data: {
              requestId: payload.requestId,
              conversationId: payload.conversationId,
              messageId: payload.messageId,
              senderId: payload.senderId,
              preview: payload.preview,
            },
            timestamp,
          });
        }
        break;
      }

      case DOMAIN_EVENTS.REPORT_COMMENT_ADDED: {
        const payload = event.payload as ReportCommentAddedPayload;

        // Las notas internas solo llegan a Soporte, y sin el texto.
        const channels = payload.internal
          ? ['admin:reports']
          : [
            `reports:${payload.reportId}`,
            payload.authorIsStaff ? `users:${payload.reporterId}` : 'admin:reports',
          ];

        for (const channel of channels) {
          await this.emitMessage({
            channel,
            event: 'report_comment',
            data: {
              reportId: payload.reportId,
              folio: payload.folio,
              authorIsStaff: payload.authorIsStaff,
              internal: payload.internal,
              preview: payload.internal ? null : payload.preview,
            },
            timestamp,
          });
        }
        break;
      }

      case DOMAIN_EVENTS.CHAT_MESSAGES_READ: {
        const payload = event.payload as ChatMessagesReadPayload;
        await this.emitMessage({
          channel: `chats:${payload.requestId}`,
          event: 'chat_messages_read',
          data: {
            requestId: payload.requestId,
            conversationId: payload.conversationId,
            readerId: payload.readerId,
            messageIds: payload.messageIds,
            readAt: payload.readAt,
          },
          timestamp,
        });
        break;
      }

      default:
        break;
    }
  }

  private async emitMessage(message: RealTimeMessage): Promise<void> {
    // El historial en memoria existe para las pruebas; se acota para que el tráfico del chat
    // no lo haga crecer sin límite en producción.
    this.publishedMessages.push(message);
    if (this.publishedMessages.length > MAX_RETAINED_MESSAGES) this.publishedMessages.shift();
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
