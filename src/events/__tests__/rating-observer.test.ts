import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import {
  ReviewCreatedEvent,
  ChatMessagesReadEvent,
  DOMAIN_EVENTS,
  type ReviewCreatedPayload,
} from '../events/domain-events.ts';
import { RatingObserver, recalculateForReview } from '../observers/rating.observer.ts';

function payload(overrides: Partial<ReviewCreatedPayload> = {}): ReviewCreatedPayload {
  return {
    reviewId: '1',
    requestId: '501',
    direction: 'cliente_a_proveedor',
    authorId: '5',
    revieweeId: '20',
    branchId: '7',
    rating: 5,
    ...overrides,
  };
}

describe('Recálculo de promedios al guardar una reseña (API-39)', () => {
  describe('recalculateForReview', () => {
    let users: bigint[];
    let branchList: bigint[];
    const deps = () => ({
      recalculateUser: async (id: bigint) => {
        users.push(id);
      },
      recalculateBranch: async (id: bigint) => {
        branchList.push(id);
      },
    });

    beforeEach(() => {
      users = [];
      branchList = [];
    });

    it('del cliente al proveedor recalcula al técnico y a la sucursal', async () => {
      await recalculateForReview(payload(), deps());
      assert.deepEqual(users, [20n]);
      assert.deepEqual(branchList, [7n]);
    });

    it('del proveedor al cliente recalcula solo al cliente', async () => {
      await recalculateForReview(
        payload({ direction: 'proveedor_a_cliente', revieweeId: '5', authorId: '20' }),
        deps(),
      );
      assert.deepEqual(users, [5n]);
      assert.deepEqual(branchList, []);
    });

    it('sin sucursal no recalcula ninguna', async () => {
      await recalculateForReview(payload({ branchId: null }), deps());
      assert.deepEqual(users, [20n]);
      assert.deepEqual(branchList, []);
    });
  });

  describe('RatingObserver en el EventBus', () => {
    let bus: EventBus;
    let received: ReviewCreatedPayload[];

    beforeEach(() => {
      bus = new EventBus();
      received = [];
    });

    it('recalcula cuando se emite REVIEW_CREATED', async () => {
      const observer = new RatingObserver(async (data) => {
        received.push(data);
      });
      bus.register(DOMAIN_EVENTS.REVIEW_CREATED, observer);

      const summary = await bus.notify(new ReviewCreatedEvent(payload()));

      assert.equal(summary.succeeded, 1);
      assert.equal(received.length, 1);
      assert.equal(received[0]!.revieweeId, '20');
      assert.equal(observer.getProcessedReviews().length, 1);
    });

    it('ignora eventos que no son de reseñas', async () => {
      const observer = new RatingObserver(async (data) => {
        received.push(data);
      });
      await observer.handle(
        new ChatMessagesReadEvent({
          requestId: '1',
          conversationId: '1',
          readerId: '1',
          messageIds: [],
          readAt: '2026-11-20T00:00:00.000Z',
        }),
      );
      assert.equal(received.length, 0);
    });

    it('un fallo del recálculo no tumba al emisor: el bus lo cuenta como fallo', async () => {
      bus.register(
        DOMAIN_EVENTS.REVIEW_CREATED,
        new RatingObserver(async () => {
          throw new Error('base de datos no disponible');
        }),
      );

      const summary = await bus.notify(new ReviewCreatedEvent(payload()));

      assert.equal(summary.failed, 1);
      assert.equal(summary.errors[0]!.observerName, 'RatingObserver');
    });
  });
});
