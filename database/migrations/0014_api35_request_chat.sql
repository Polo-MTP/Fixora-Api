-- API-35: chat por solicitud.
-- Una sola conversación por solicitud (la crea la aceptación, o el primer acceso si ya estaba aceptada).
CREATE UNIQUE INDEX IF NOT EXISTS conversations_request_id_unique
  ON conversations (request_id);

-- Un mensaje puede llevar solo fotos: el texto deja de ser obligatorio (la API exige texto o foto).
ALTER TABLE request_messages
  ALTER COLUMN message DROP NOT NULL;

-- El mismo remitente no puede repetir un client_uuid dentro de una conversación (reintentos sin duplicar).
CREATE UNIQUE INDEX IF NOT EXISTS request_messages_client_uuid_unique
  ON request_messages (conversation_id, sender_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

-- Paginación por cursor y conteo de no leídos.
CREATE INDEX IF NOT EXISTS request_messages_conversation_idx
  ON request_messages (conversation_id, "UniqueID");

CREATE INDEX IF NOT EXISTS request_messages_unread_idx
  ON request_messages (conversation_id)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS message_attachments_message_idx
  ON message_attachments (message_id);
