import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { notifications, service_payments, service_requests } from '../database/schema/tables.ts';
import { eventBus } from '../events/event-bus.ts';
import { DebtReminderEvent } from '../events/events/domain-events.ts';
import {
  DEBT_REMINDER_EVERY_MS,
  MAX_DEBT_REMINDERS,
  summarizePayments,
  totalToCharge,
} from './payment.rules.ts';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DEBT_REMINDER_TYPE = 'recordatorio_adeudo';

/**
 * Manda los recordatorios de adeudo que tocan: a un día de finalizado el servicio, y después uno
 * al día hasta MAX_DEBT_REMINDERS. Las propias notificaciones guardadas dicen cuántos se mandaron
 * y cuándo, así que no depende de memoria del proceso ni se repite tras un reinicio.
 * Regresa cuántos mandó.
 */
export async function sendDueDebtReminders(now = new Date()): Promise<number> {
  // Después del último recordatorio ya no hay nada que mandar: solo se revisa esa ventana.
  const oldest = new Date(now.getTime() - (MAX_DEBT_REMINDERS + 1) * DEBT_REMINDER_EVERY_MS);
  const newest = new Date(now.getTime() - DEBT_REMINDER_EVERY_MS);
  const candidates = await db
    .select()
    .from(service_requests)
    .where(
      and(
        eq(service_requests.status, 'completada'),
        gte(service_requests.completed_at, oldest),
        lte(service_requests.completed_at, newest),
      ),
    );
  if (!candidates.length) return 0;

  const ids = candidates.map((request) => request.UniqueID);
  const payments = await db
    .select()
    .from(service_payments)
    .where(inArray(service_payments.request_id, ids));
  const sent = await db
    .select({
      requestId: notifications.entity_id,
      count: sql<number>`count(*)::int`,
      last: sql<Date>`max(${notifications.created_at})`,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, DEBT_REMINDER_TYPE),
        eq(notifications.entity_type, 'service_request'),
        inArray(notifications.entity_id, ids),
      ),
    )
    .groupBy(notifications.entity_id);

  let count = 0;
  for (const request of candidates) {
    const summary = summarizePayments(
      await totalToCharge(db, request),
      payments.filter((payment) => payment.request_id === request.UniqueID),
      true,
    );
    // Con un pago esperando confirmación no se le insiste: ya hizo su parte.
    if (!summary.has_debt || summary.pending_confirmation !== '0.00') continue;

    const history = sent.find((row) => row.requestId === request.UniqueID);
    if (history && Number(history.count) >= MAX_DEBT_REMINDERS) continue;
    if (history && now.getTime() - new Date(history.last).getTime() < DEBT_REMINDER_EVERY_MS) {
      continue;
    }

    await eventBus.notify(
      new DebtReminderEvent({
        requestId: request.UniqueID.toString(),
        clientId: request.client_id.toString(),
        balanceDue: summary.balance_due,
      }),
    );
    count++;
  }
  return count;
}

/** Revisa cada hora si hay recordatorios de adeudo que mandar (API-37). */
export class DebtReminderService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    (this.interval as unknown as { unref?: () => void }).unref?.();
    void this.tick();
    console.log('Worker de recordatorios de adeudo iniciado.');
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await sendDueDebtReminders();
    } catch (error) {
      console.error('Error al mandar recordatorios de adeudo:', error);
    } finally {
      this.running = false;
    }
  }
}

export const debtReminderService = new DebtReminderService();
