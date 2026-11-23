import type { DomainEvent } from './domain-event.interface.ts';
import type { Observer } from './observer.interface.ts';

export interface DispatchSummary {
  readonly eventId: string;
  readonly eventType: string;
  readonly totalObservers: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ observerName: string; error: Error }>;
}

export interface Subject {
  register<E extends DomainEvent>(eventType: string, observer: Observer<E>): void;
  unregister(eventType: string, observerName: string): boolean;
  notify<E extends DomainEvent>(event: E): Promise<DispatchSummary>;
  hasObserver(eventType: string, observerName: string): boolean;
  getObservers(eventType?: string): ReadonlyArray<Observer>;
  clear(): void;
}
