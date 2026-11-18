-- API-20: el proveedor independiente es quien atiende, así que debe existir como técnico
-- (employees) de su sucursal para tener foto, biografía y vehículo y recibir solicitudes.
-- Desde ahora se crea al aprobar la solicitud; esto lo agrega a los que ya estaban aprobados.
INSERT INTO employees (user_id, branch_id, can_attend, active)
SELECT DISTINCT s.user_id, first_branch.id, true, true
FROM suppliers s
JOIN supplier_applications sa
  ON sa.supplier_id = s."UniqueID" AND sa.state = 'aprobada'
JOIN business_supplier bs
  ON bs.supplier_id = s."UniqueID" AND bs.active = true
JOIN LATERAL (
  SELECT b."UniqueID" AS id
  FROM branches b
  WHERE b.business_id = bs.business_id
  ORDER BY b."UniqueID"
  LIMIT 1
) first_branch ON true
WHERE s.supplier_type = 'independiente'
  AND NOT EXISTS (
    SELECT 1 FROM employees e
    WHERE e.user_id = s.user_id AND e.branch_id = first_branch.id
  );
