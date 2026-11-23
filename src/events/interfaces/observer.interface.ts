import type { DomainEvent } from './domain-event.interface.ts';

export interface Observer<E extends DomainEvent = DomainEvent> {
  readonly name: string;
  handle(event: E): Promise<void> | void;
}
