-- API-27: un mismo cliente no puede crear dos solicitudes con el mismo client_uuid.
-- El índice parcial permite conservar registros históricos con client_uuid NULL.
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_client_uuid_unique
  ON service_requests (client_id, client_uuid)
  WHERE client_uuid IS NOT NULL;
