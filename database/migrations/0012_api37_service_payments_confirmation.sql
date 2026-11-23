-- API-37: el cliente registra el pago y el proveedor confirma que lo recibió. Se escribe a mano
-- como las migraciones 0004 a 0011: drizzle-kit generate repetiría cambios que esas ya aplicaron,
-- porque no actualizaron los snapshots.
ALTER TABLE "service_payments"
  ADD COLUMN IF NOT EXISTS "registered_by" bigint REFERENCES "users"("UniqueID"),
  ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "confirmed_by" bigint REFERENCES "users"("UniqueID"),
  ADD COLUMN IF NOT EXISTS "responded_at" timestamp,
  ADD COLUMN IF NOT EXISTS "rejection_reason" varchar(500);

-- Un reintento del mismo pago (misma llave) no crea un segundo registro.
CREATE UNIQUE INDEX IF NOT EXISTS service_payments_client_uuid_unique
  ON service_payments (request_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS service_payments_request_status_idx
  ON service_payments (request_id, status);
