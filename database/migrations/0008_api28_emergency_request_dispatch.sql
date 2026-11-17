-- API-28: permitir solicitudes de emergencia sin sucursal ni dirección postal
-- hasta que un técnico acepte; las coordenadas actuales se guardan en la solicitud.
ALTER TABLE service_requests
  ALTER COLUMN branch_id DROP NOT NULL,
  ALTER COLUMN address_id DROP NOT NULL;

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS latitude numeric(10, 7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10, 7);

-- API-30 usará este valor para retirar los avisos de los técnicos que no ganaron la aceptación.
ALTER TYPE dispatch_response ADD VALUE IF NOT EXISTS 'retirado';

CREATE INDEX IF NOT EXISTS request_dispatches_request_employee_idx
  ON request_dispatches (request_id, employee_id);

CREATE INDEX IF NOT EXISTS request_dispatches_employee_response_idx
  ON request_dispatches (employee_id, response);
