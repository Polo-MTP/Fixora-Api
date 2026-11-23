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

export interface ReminderHistory {
  /** Recordatorios mandados: automáticos y manuales. */
  count: number;
  last: Date;
}

/**
 * Cuántos recordatorios de adeudo se han mandado por solicitud y cuándo fue el último. Sale de las
 * notificaciones guardadas, así que cuenta igual los automáticos y los que manda el proveedor.
 */
export async function reminderHistory(requestIds: bigint[]): Promise<Map<string, ReminderHistory>> {
  const history = new Map<string, ReminderHistory>();
  if (!requestIds.length) return history;
  const rows = await db
    .select({
      requestId: notifications.entity_id,
      count: sql<number>`count(*)::int`,
      // Con el mismo conversor de la columna: la fecha se guarda en UTC sin zona horaria.
      last: sql<Date>`max(${notifications.created_at})`.mapWith(notifications.created_at),
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, DEBT_REMINDER_TYPE),
        eq(notifications.entity_type, 'service_request'),
        inArray(notifications.entity_id, requestIds),
      ),
    )
    .groupBy(notifications.entity_id);
  for (const row of rows) {
    if (row.requestId === null) continue;
    history.set(row.requestId.toString(), { count: Number(row.count), last: row.last });
  }
  return history;
}

/** Cuándo se puede mandar el siguiente recordatorio; null si ya se puede. */
export function nextReminderAllowedAt(last: Date | undefined, now = new Date()): Date | null {
  if (!last) return null;
  const next = new Date(last.getTime() + DEBT_REMINDER_EVERY_MS);
  return next.getTime() > now.getTime() ? next : null;
}

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
  const sent = await reminderHistory(ids);

  let count = 0;
  for (const request of candidates) {
    const summary = summarizePayments(
      await totalToCharge(db, request),
      payments.filter((payment) => payment.request_id === request.UniqueID),
      true,
    );
    // Con un pago esperando confirmación no se le insiste: ya hizo su parte.
    if (!summary.has_debt || summary.pending_confirmation !== '0.00') continue;

    const history = sent.get(request.UniqueID.toString());
    if (history && history.count >= MAX_DEBT_REMINDERS) continue;
    if (nextReminderAllowedAt(history?.last, now)) continue;

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
