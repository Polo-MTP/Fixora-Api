-- API-25: fecha de creación para ordenar y paginar el centro de notificaciones.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS notifications_user_created_at_idx
  ON notifications (user_id, created_at DESC, "UniqueID" DESC);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, read_at)
  WHERE read_at IS NULL;
