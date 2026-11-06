import type { DomainEvent } from './interfaces/domain-event.interface.ts';
import type { Observer } from './interfaces/observer.interface.ts';
import type { Subject, DispatchSummary } from './interfaces/subject.interface.ts';

export class EventBus implements Subject {
  private readonly listeners: Map<string, Set<Observer<DomainEvent<unknown>>>> = new Map();

  /**
   * Registra un observador para un tipo específico de evento de dominio, o '*' para todos
   */
  public register<E extends DomainEvent>(eventType: string, observer: Observer<E>): void {
    if (!eventType || typeof eventType !== 'string') {
      throw new Error('El tipo de evento (eventType) debe ser una cadena no vacía.');
    }
    if (!observer || typeof observer.handle !== 'function' || !observer.name) {
      throw new Error('El observador debe tener una propiedad "name" y un método "handle".');
    }

    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }

    const observersSet = this.listeners.get(eventType)!;

    // Evitar registrar dos veces el mismo observador por nombre
    for (const existing of observersSet) {
      if (existing.name === observer.name) {
        observersSet.delete(existing);
        break;
      }
    }

    observersSet.add(observer as Observer<DomainEvent<unknown>>);
  }

  /**
   * Elimina el registro de un observador dado su nombre y el tipo de evento
   */
  public unregister(eventType: string, observerName: string): boolean {
    const observersSet = this.listeners.get(eventType);
    if (!observersSet) return false;

    for (const observer of observersSet) {
      if (observer.name === observerName) {
        observersSet.delete(observer);
        if (observersSet.size === 0) {
          this.listeners.delete(eventType);
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Verifica si un observador está registrado para un tipo de evento
   */
  public hasObserver(eventType: string, observerName: string): boolean {
    const observersSet = this.listeners.get(eventType);
    if (!observersSet) return false;

    for (const observer of observersSet) {
      if (observer.name === observerName) return true;
    }
    return false;
  }

  /**
   * Obtiene la lista de observadores registrados (opcionalmente filtrado por tipo de evento)
   */
  public getObservers(eventType?: string): ReadonlyArray<Observer> {
    if (eventType) {
      const specific = Array.from(this.listeners.get(eventType) ?? []);
      const wildcards = Array.from(this.listeners.get('*') ?? []);
      const merged = new Map<string, Observer>();
      for (const obs of [...specific, ...wildcards]) {
        merged.set(obs.name, obs);
      }
      return Array.from(merged.values());
    }

    const all = new Map<string, Observer>();
    for (const set of this.listeners.values()) {
      for (const obs of set) {
        all.set(obs.name, obs);
      }
    }
    return Array.from(all.values());
  }

  /**
   * Emite un evento de dominio a todos los observadores registrados,
   * aislando fallos para que un error en un observador no afecte a los demás
   */
  public async notify<E extends DomainEvent>(event: E): Promise<DispatchSummary> {
    if (!event || !event.eventType) {
      throw new Error('No se puede emitir un evento nulo o sin "eventType".');
    }

    const specificSet = this.listeners.get(event.eventType) ?? new Set();
    const wildcardSet = this.listeners.get('*') ?? new Set();

    // Combinar observadores evitando duplicaciones por nombre
    const targetObservers = new Map<string, Observer<E>>();
    for (const obs of specificSet) targetObservers.set(obs.name, obs as unknown as Observer<E>);
    for (const obs of wildcardSet) targetObservers.set(obs.name, obs as unknown as Observer<E>);

    const observerList = Array.from(targetObservers.values());
    const errors: Array<{ observerName: string; error: Error }> = [];
    let succeeded = 0;

    const executions = observerList.map(async (observer) => {
      try {
        await Promise.resolve(observer.handle(event));
        succeeded++;
      } catch (err) {
        const errorInstance = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[EventBus] Error en el observador "${observer.name}" procesando "${event.eventType}":`,
          errorInstance.message,
        );
        errors.push({ observerName: observer.name, error: errorInstance });
      }
    });

    await Promise.allSettled(executions);

    return {
      eventId: event.eventId,
      eventType: event.eventType,
      totalObservers: observerList.length,
      succeeded,
      failed: errors.length,
      errors,
    };
  }

  /**
   * Limpia todos los observadores registrados
   */
  public clear(): void {
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();
