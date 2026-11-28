import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import { DOMAIN_EVENTS, type ReportStatusChangedPayload } from '../events/domain-events.ts';
import { evaluateAutoMark } from '../../services/sanction.service.ts';

export type AutoMarkEvaluator = (payload: ReportStatusChangedPayload) => Promise<void>;

const MAX_RETAINED_PAYLOADS = 500;

/**
 * Regla automática de marcas (API-42): cuando un reporte queda resuelto (confirmado), revisa si la
 * persona señalada superó el número de reportes confirmados y, de ser así, la marca.
 * Si falla, el EventBus lo registra; la siguiente resolución vuelve a evaluar con el conteo completo.
 */
export class SanctionObserver implements Observer<DomainEvent> {
  public readonly name = 'SanctionObserver';
  private readonly evaluator: AutoMarkEvaluator;
  private readonly evaluated: ReportStatusChangedPayload[] = [];

  constructor(customEvaluator?: AutoMarkEvaluator) {
    this.evaluator =
      customEvaluator ??
      (async (payload) => {
        await evaluateAutoMark(BigInt(payload.reportId), BigInt(payload.changedBy));
      });
  }

  public async handle(event: DomainEvent): Promise<void> {
    if (event.eventType !== DOMAIN_EVENTS.REPORT_STATUS_CHANGED) return;

    const payload = event.payload as ReportStatusChangedPayload;
    // Solo los reportes confirmados cuentan.
    if (payload.toStatus !== 'resuelto') return;

    await this.evaluator(payload);

    // Solo para pruebas; se acota para no crecer sin límite en producción.
    this.evaluated.push(payload);
    if (this.evaluated.length > MAX_RETAINED_PAYLOADS) this.evaluated.shift();
  }

  public getEvaluatedReports(): ReadonlyArray<ReportStatusChangedPayload> {
    return this.evaluated;
  }
}
