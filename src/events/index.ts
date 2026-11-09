import { eventBus, EventBus } from './event-bus.ts';
import { NotificationObserver } from './observers/notification.observer.ts';
import { HistoryObserver } from './observers/history.observer.ts';
import { RealTimeObserver } from './observers/realtime.observer.ts';
import { EmailObserver } from './observers/email.observer.ts';
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

export interface SetupObserversOptions {
  notificationObserver?: NotificationObserver;
  historyObserver?: HistoryObserver;
  realtimeObserver?: RealTimeObserver;
  emailObserver?: EmailObserver;
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

  // Registrar observadores para los eventos de dominio principales
  const domainEventTypes = [
    DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED,
    DOMAIN_EVENTS.REPORT_STATUS_CHANGED,
    DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED,
  ];

  for (const eventType of domainEventTypes) {
    bus.register(eventType, notificationObserver);
    bus.register(eventType, historyObserver);
    bus.register(eventType, realtimeObserver);
  }

  bus.register(DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED, notificationObserver);
  bus.register(DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED, realtimeObserver);
  bus.register(DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED, emailObserver);

  return {
    bus,
    notificationObserver,
    historyObserver,
    realtimeObserver,
    emailObserver,
  };
}
