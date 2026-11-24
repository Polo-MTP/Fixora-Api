import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import { DOMAIN_EVENTS, type ReviewCreatedPayload } from '../events/domain-events.ts';
import { recalculateBranchRating, recalculateUserRating } from '../../services/rating.service.ts';

export type RatingRecalculator = (payload: ReviewCreatedPayload) => Promise<void>;

export interface RatingRecalculationDeps {
  recalculateUser: (userId: bigint) => Promise<void>;
  recalculateBranch: (branchId: bigint) => Promise<void>;
}

const MAX_RETAINED_PAYLOADS = 500;

/**
 * Decide qué promedios se recalculan al guardarse una reseña:
 * - Siempre, el del usuario reseñado.
 * - Además, el de la sucursal, solo cuando la reseña es del cliente hacia el proveedor.
 */
export async function recalculateForReview(
  payload: ReviewCreatedPayload,
  deps: RatingRecalculationDeps = {
    recalculateUser: recalculateUserRating,
    recalculateBranch: recalculateBranchRating,
  },
): Promise<void> {
  await deps.recalculateUser(BigInt(payload.revieweeId));
  if (payload.direction === 'cliente_a_proveedor' && payload.branchId) {
    await deps.recalculateBranch(BigInt(payload.branchId));
  }
}

/**
 * Mantiene al día rating_avg y reviews_count al guardarse una reseña (API-39).
 * Si falla, el EventBus lo registra y lo cuenta como fallo de este observador; la reseña ya quedó
 * guardada y el siguiente recálculo corrige los totales porque siempre parte de las reseñas.
 */
export class RatingObserver implements Observer<DomainEvent> {
  public readonly name = 'RatingObserver';
  private readonly recalculator: RatingRecalculator;
  private readonly processed: ReviewCreatedPayload[] = [];

  constructor(customRecalculator?: RatingRecalculator) {
    this.recalculator = customRecalculator ?? ((payload) => recalculateForReview(payload));
  }

  public async handle(event: DomainEvent): Promise<void> {
    if (event.eventType !== DOMAIN_EVENTS.REVIEW_CREATED) return;

    const payload = event.payload as ReviewCreatedPayload;
    await this.recalculator(payload);

    // Solo para pruebas; se acota para no crecer sin límite en producción.
    this.processed.push(payload);
    if (this.processed.length > MAX_RETAINED_PAYLOADS) this.processed.shift();
  }

  public getProcessedReviews(): ReadonlyArray<ReviewCreatedPayload> {
    return this.processed;
  }
}
