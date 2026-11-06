export interface DomainEvent<T = unknown> {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredOn: Date;
  readonly aggregateId: string;
  readonly payload: T;
}
