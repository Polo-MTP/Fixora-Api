-- API-26: separar los hitos En camino y Llegado en el enum de solicitudes.
-- Ejecutar una sola vez en PostgreSQL antes de desplegar la nueva versión de la API.
ALTER TYPE service_request_status ADD VALUE IF NOT EXISTS 'en_camino';
ALTER TYPE service_request_status ADD VALUE IF NOT EXISTS 'llegado';
