import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { notifications } from '../database/schema/tables.ts';
import { AppError, NotFoundError } from '../errors/app-error.ts';

export interface ListNotificationsOptions {
  unread?: boolean;
  page: number;
  limit: number;
}

function userFilter(userId: string | bigint) {
  return eq(notifications.user_id, BigInt(userId));
}

export class NotificationsService {
  async list(userId: string | bigint, options: ListNotificationsOptions) {
    const baseFilter = userFilter(userId);
    const filters = options.unread ? and(baseFilter, isNull(notifications.read_at)) : baseFilter;
    const offset = (options.page - 1) * options.limit;

    const [rows, totalRows, unreadRows] = await Promise.all([
      db
        .select({
          id: notifications.UniqueID,
          type: notifications.type,
          title: notifications.title,
          message: notifications.message,
          entity_type: notifications.entity_type,
          entity_id: notifications.entity_id,
          read_at: notifications.read_at,
          created_at: notifications.created_at,
        })
        .from(notifications)
        .where(filters)
        .orderBy(desc(notifications.created_at), desc(notifications.UniqueID))
        .limit(options.limit)
        .offset(offset),
      db.select({ total: count() }).from(notifications).where(filters),
      db
        .select({ total: count() })
        .from(notifications)
        .where(and(baseFilter, isNull(notifications.read_at))),
    ]);

    const total = Number(totalRows[0]?.total ?? 0);
    const unreadCount = Number(unreadRows[0]?.total ?? 0);

    return {
      data: rows.map((row) => ({
        id: row.id.toString(),
        type: row.type,
        title: row.title,
        message: row.message,
        entity_type: row.entity_type,
        entity_id: row.entity_id?.toString() ?? null,
        read_at: row.read_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
      })),
      unread_count: unreadCount,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / options.limit),
      },
    };
  }

  async markAsRead(userId: string | bigint, notificationId: string): Promise<void> {
    const id = this.parseId(notificationId);
    const ownerFilter = and(eq(notifications.UniqueID, id), userFilter(userId));

    const [existing] = await db
      .select({ id: notifications.UniqueID, read_at: notifications.read_at })
      .from(notifications)
      .where(ownerFilter)
      .limit(1);

    if (!existing) throw new NotFoundError('Recurso no encontrado.');

    if (!existing.read_at) {
      await db
        .update(notifications)
        .set({ read_at: new Date() })
        .where(and(ownerFilter, isNull(notifications.read_at)));
    }
  }

  async markAllAsRead(userId: string | bigint): Promise<void> {
    await db
      .update(notifications)
      .set({ read_at: new Date() })
      .where(and(userFilter(userId), isNull(notifications.read_at)));
  }

  private parseId(value: string): bigint {
    if (!/^[1-9]\d{0,17}$/.test(value)) {
      throw new AppError(
        'El identificador de notificación no es válido.',
        400,
        'INVALID_NOTIFICATION_ID',
      );
    }
    return BigInt(value);
  }
}

export const notificationsService = new NotificationsService();
