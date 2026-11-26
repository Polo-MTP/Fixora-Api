import { eventBus, EventBus } from './event-bus.ts';
import { NotificationObserver } from './observers/notification.observer.ts';
import { HistoryObserver } from './observers/history.observer.ts';
import { RealTimeObserver } from './observers/realtime.observer.ts';
import { EmailObserver } from './observers/email.observer.ts';
import { RatingObserver } from './observers/rating.observer.ts';
import { SanctionObserver } from './observers/sanction.observer.ts';
import { DOMAIN_EVENTS } from './events/domain-events.ts';

export * from './interfaces/domain-event.interface.ts';
export * from './interfaces/observer.interface.ts';
export * from './interfaces/subject.interface.ts';
export * from './events/domain-events.ts';
export * from './event-bus.ts';
export * from './observers/notification.observer.ts';
export * from './observers/history.observer.ts';
export * from './observers/realtime.observer.ts';
export * from './observers/email.observer.ts';
export * from './observers/rating.observer.ts';
export * from './observers/sanction.observer.ts';

export interface SetupObserversOptions {
  notificationObserver?: NotificationObserver;
  historyObserver?: HistoryObserver;
  realtimeObserver?: RealTimeObserver;
  emailObserver?: EmailObserver;
  ratingObserver?: RatingObserver;
  sanctionObserver?: SanctionObserver;
}

/**
 * Configura y conecta los observadores desacoplados al bus de eventos de dominio
 */
export function setupDomainEventObservers(
  bus: EventBus = eventBus,
  options?: SetupObserversOptions,
) {
  const notificationObserver = options?.notificationObserver ?? new NotificationObserver();
  const historyObserver = options?.historyObserver ?? new HistoryObserver();
  const realtimeObserver = options?.realtimeObserver ?? new RealTimeObserver();
  const emailObserver = options?.emailObserver ?? new EmailObserver();
  const ratingObserver = options?.ratingObserver ?? new RatingObserver();
  const sanctionObserver = options?.sanctionObserver ?? new SanctionObserver();

  // Registrar observadores para los eventos de dominio principales
  const domainEventTypes = [
    DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED,
    DOMAIN_EVENTS.SERVICE_REQUEST_DISPATCHED,
    DOMAIN_EVENTS.SERVICE_REQUEST_REJECTED,
    DOMAIN_EVENTS.REPORT_STATUS_CHANGED,
    DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED,
  ];

  for (const eventType of domainEventTypes) {
    bus.register(eventType, notificationObserver);
    bus.register(eventType, historyObserver);
    bus.register(eventType, realtimeObserver);
  }

  // Ajustes de precio (API-36): avisos y tiempo real; no son cambios de estado de la solicitud.
  for (const eventType of [
    DOMAIN_EVENTS.PRICE_ADJUSTMENT_PROPOSED,
    DOMAIN_EVENTS.PRICE_ADJUSTMENT_RESPONDED,
    DOMAIN_EVENTS.PAYMENT_REGISTERED,
    DOMAIN_EVENTS.PAYMENT_RESPONDED,
  ]) {
    bus.register(eventType, notificationObserver);
    bus.register(eventType, realtimeObserver);
  }

  // El recordatorio de adeudo solo se le avisa al cliente.
  bus.register(DOMAIN_EVENTS.DEBT_REMINDER, notificationObserver);

  bus.register(DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED, notificationObserver);
  bus.register(DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED, realtimeObserver);
  bus.register(DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED, emailObserver);

  // Chat por solicitud (API-35): tiempo real para todos, push solo en CHAT_MESSAGE_SENT.
  bus.register(DOMAIN_EVENTS.CHAT_MESSAGE_SENT, notificationObserver);
  bus.register(DOMAIN_EVENTS.CHAT_MESSAGE_SENT, realtimeObserver);
  bus.register(DOMAIN_EVENTS.CHAT_MESSAGES_READ, realtimeObserver);

  // Comentarios de reportes (API-40): aviso a quien reportó y tiempo real.
  bus.register(DOMAIN_EVENTS.REPORT_COMMENT_ADDED, notificationObserver);
  bus.register(DOMAIN_EVENTS.REPORT_COMMENT_ADDED, realtimeObserver);

  // Reseñas (API-39): recalcula rating_avg y reviews_count al guardarse una reseña.
  bus.register(DOMAIN_EVENTS.REVIEW_CREATED, ratingObserver);

  // Sanciones (API-42): la regla automática marca al superar el umbral de reportes confirmados,
  // y se avisa a la persona sancionada cuando se aplica o se retira una sanción.
  bus.register(DOMAIN_EVENTS.REPORT_STATUS_CHANGED, sanctionObserver);
  bus.register(DOMAIN_EVENTS.SANCTION_APPLIED, notificationObserver);
  bus.register(DOMAIN_EVENTS.SANCTION_LIFTED, notificationObserver);

  return {
    bus,
    notificationObserver,
    historyObserver,
    realtimeObserver,
    emailObserver,
    ratingObserver,
    sanctionObserver,
  };
}
