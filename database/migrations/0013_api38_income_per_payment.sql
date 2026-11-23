-- API-38: un ingreso por cada pago confirmado. Se escribe a mano como las migraciones 0004 a 0012:
-- drizzle-kit generate repetiría cambios que esas ya aplicaron, porque no actualizaron los
-- snapshots.
CREATE UNIQUE INDEX IF NOT EXISTS income_records_payment_unique
  ON income_records (payment_id);

-- Listado del administrador: por sucursal, por estado de la comisión y por fecha.
CREATE INDEX IF NOT EXISTS income_records_branch_created_idx
  ON income_records (branch_id, created_at);

CREATE INDEX IF NOT EXISTS income_records_commission_status_idx
  ON income_records (commission_status);

-- El porcentaje vigente es el más reciente que ya entró en vigor.
CREATE INDEX IF NOT EXISTS commission_settings_effective_from_idx
  ON commission_settings (effective_from);
