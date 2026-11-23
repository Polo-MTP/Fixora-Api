-- API-36: ajustes de precio que el técnico propone y el cliente aprueba o rechaza. Se escribe a
-- mano como las migraciones 0004 a 0010: drizzle-kit generate repetiría cambios que esas ya
-- aplicaron, porque no actualizaron los snapshots.
ALTER TABLE "price_adjustment"
  ADD COLUMN IF NOT EXISTS "description" varchar(500),
  ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "responded_at" timestamp,
  ADD COLUMN IF NOT EXISTS "client_uuid" varchar(100);

-- Un reintento del mismo ajuste (misma llave) no crea un segundo registro.
CREATE UNIQUE INDEX IF NOT EXISTS price_adjustment_client_uuid_unique
  ON price_adjustment (request_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS price_adjustment_request_status_idx
  ON price_adjustment (request_id, status);
