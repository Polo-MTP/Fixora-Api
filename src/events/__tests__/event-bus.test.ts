import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import type { Observer } from '../interfaces/observer.interface.ts';
import { BaseDomainEvent } from '../events/domain-events.ts';

class DummyEvent extends BaseDomainEvent<{ message: string }> {
  constructor(message: string, aggregateId = 'agg-1') {
    super('dummy.event', aggregateId, { message });
  }
}

class AnotherEvent extends BaseDomainEvent<{ code: number }> {
  constructor(code: number, aggregateId = 'agg-2') {
    super('another.event', aggregateId, { code });
  }
}

describe('EventBus (Subject del patrón Observer)', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('debe registrar y consultar observadores correctamente', () => {
    const observer: Observer = {
      name: 'TestObserver',
      handle: () => {},
    };

    bus.register('dummy.event', observer);

    assert.equal(bus.hasObserver('dummy.event', 'TestObserver'), true);
    assert.equal(bus.hasObserver('dummy.event', 'NonExistent'), false);
    assert.equal(bus.hasObserver('other.event', 'TestObserver'), false);

    const observers = bus.getObservers('dummy.event');
    assert.equal(observers.length, 1);
    assert.equal(observers[0].name, 'TestObserver');
  });

  it('debe desregistrar un observador por nombre', () => {
    const observer: Observer = {
      name: 'RemovableObserver',
      handle: () => {},
    };

    bus.register('dummy.event', observer);
    assert.equal(bus.hasObserver('dummy.event', 'RemovableObserver'), true);

    const unregistered = bus.unregister('dummy.event', 'RemovableObserver');
    assert.equal(unregistered, true);
    assert.equal(bus.hasObserver('dummy.event', 'RemovableObserver'), false);

    const secondAttempt = bus.unregister('dummy.event', 'RemovableObserver');
    assert.equal(secondAttempt, false);
  });

  it('debe emitir eventos a los observadores registrados para el tipo de evento', async () => {
    const received: string[] = [];

    const observer1: Observer<DummyEvent> = {
      name: 'Obs1',
      handle: (e) => {
        received.push(`Obs1:${e.payload.message}`);
      },
    };

    const observer2: Observer<DummyEvent> = {
      name: 'Obs2',
      handle: (e) => {
        received.push(`Obs2:${e.payload.message}`);
      },
    };

    bus.register('dummy.event', observer1);
    bus.register('dummy.event', observer2);

    const event = new DummyEvent('Hola Fixora');
    const summary = await bus.notify(event);

    assert.equal(summary.totalObservers, 2);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 0);
    assert.deepEqual(received, ['Obs1:Hola Fixora', 'Obs2:Hola Fixora']);
  });

  it('un observador wildcard (*) debe recibir todos los eventos', async () => {
    const wildcardEvents: string[] = [];

    const wildcardObs: Observer = {
      name: 'WildcardObs',
      handle: (e) => {
        wildcardEvents.push(e.eventType);
      },
    };

    bus.register('*', wildcardObs);

    await bus.notify(new DummyEvent('test'));
    await bus.notify(new AnotherEvent(404));

    assert.equal(wildcardEvents.length, 2);
    assert.deepEqual(wildcardEvents, ['dummy.event', 'another.event']);
  });

  it('debe aislar errores para que un fallo en un observador no afecte a los demás', async () => {
    let secondObserverRan = false;

    const failingObs: Observer = {
      name: 'FailingObs',
      handle: () => {
        throw new Error('Fallo simulado en observador');
      },
    };

    const successfulObs: Observer = {
      name: 'SuccessfulObs',
      handle: () => {
        secondObserverRan = true;
      },
    };

    bus.register('dummy.event', failingObs);
    bus.register('dummy.event', successfulObs);

    const summary = await bus.notify(new DummyEvent('prueba fallo'));

    assert.equal(summary.totalObservers, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].observerName, 'FailingObs');
    assert.equal(summary.errors[0].error.message, 'Fallo simulado en observador');
    assert.equal(secondObserverRan, true);
  });

  it('no debe duplicar observadores si se registra el mismo nombre dos veces', () => {
    let _callCount = 0;
    const observerA: Observer = {
      name: 'UniqueName',
      handle: () => {
        _callCount++;
      },
    };
    const observerB: Observer = {
      name: 'UniqueName',
      handle: () => {
        _callCount++;
      },
    };

    bus.register('dummy.event', observerA);
    bus.register('dummy.event', observerB);

    assert.equal(bus.getObservers('dummy.event').length, 1);
  });

  it('clear() debe eliminar todos los observadores registrados', () => {
    bus.register('dummy.event', { name: 'O1', handle: () => {} });
    bus.register('other.event', { name: 'O2', handle: () => {} });

    assert.equal(bus.getObservers().length, 2);
    bus.clear();
    assert.equal(bus.getObservers().length, 0);
  });
});
