-- Gerente de un local: marca explícita en employees.
-- Con manager_is_owner el proveedor queda como gerente de su local usando su misma cuenta (rol
-- proveedor), así que el rol del usuario ya no basta para saber quién gerencia el local.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_manager boolean NOT NULL DEFAULT false;

-- Los gerentes que ya existen (cuenta con rol gerente) quedan marcados.
UPDATE employees e
SET is_manager = true
FROM users u
JOIN roles r ON r."UniqueID" = u.role_id
WHERE u."UniqueID" = e.user_id
  AND r.name = 'gerente'
  AND e.is_manager = false;

CREATE INDEX IF NOT EXISTS employees_branch_manager_idx
  ON employees (branch_id)
  WHERE is_manager = true;
