-- API-48: historial de servicios del cliente.

-- Lista del historial (más reciente primero) y filtro por estado.
CREATE INDEX IF NOT EXISTS service_requests_client_created_idx
  ON service_requests (client_id, created_at DESC);

-- Servicio en curso del banner de la pantalla principal.
CREATE INDEX IF NOT EXISTS service_requests_client_status_idx
  ON service_requests (client_id, status);
