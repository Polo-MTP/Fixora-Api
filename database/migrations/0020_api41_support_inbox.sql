-- API-41: bandeja de Soporte e historial auditable del servicio.

-- Bandeja: "mis reportes abiertos" y "sin asignar".
CREATE INDEX IF NOT EXISTS reports_assigned_status_idx
  ON reports (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- Línea de tiempo del servicio: estados y archivos de una solicitud en orden.
CREATE INDEX IF NOT EXISTS service_request_events_request_idx
  ON service_request_events (request_id, "UniqueID");

CREATE INDEX IF NOT EXISTS request_attachments_request_idx
  ON request_attachments (request_id, "UniqueID");
