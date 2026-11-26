-- API-42: sanciones y marcas de usuarios problemáticos.

-- De dónde viene la sanción (manual de Soporte, o la regla automática) y cómo se retiró.
ALTER TABLE account_sanctions
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS lifted_at timestamp,
  ADD COLUMN IF NOT EXISTS lifted_by bigint REFERENCES users ("UniqueID"),
  ADD COLUMN IF NOT EXISTS lift_reason text;

-- Consulta de sanciones vigentes de un usuario (restricción al crear solicitudes, alerta al proveedor).
CREATE INDEX IF NOT EXISTS account_sanctions_user_active_idx
  ON account_sanctions (user_id, type)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS account_sanctions_user_idx
  ON account_sanctions (user_id, created_at DESC);

-- Reportes que se cuentan contra un usuario (regla automática y alerta al proveedor).
CREATE INDEX IF NOT EXISTS reports_reported_status_idx
  ON reports (reported_id, status);
