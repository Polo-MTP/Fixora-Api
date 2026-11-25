-- API-40: reportes con evidencia y bitácora; garantías y reclamaciones por el mismo mecanismo.

-- Tipo de caso: reporte, garantía o reclamación.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_type') THEN
    CREATE TYPE report_type AS ENUM ('reporte', 'garantia', 'reclamacion');
  END IF;
END
$$;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS type report_type NOT NULL DEFAULT 'reporte',
  ADD COLUMN IF NOT EXISTS folio varchar(20),
  ADD COLUMN IF NOT EXISTS reported_id bigint REFERENCES users ("UniqueID"),
  ADD COLUMN IF NOT EXISTS client_uuid varchar(100),
  ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS resolved_at timestamp;

-- Folios consecutivos: REP-2026-000123, GAR-... y REC-...
CREATE SEQUENCE IF NOT EXISTS reports_folio_seq;

-- Reportes que ya existan reciben folio con su propio id.
UPDATE reports
SET folio = 'REP-' || to_char(created_at, 'YYYY') || '-' || lpad("UniqueID"::text, 6, '0')
WHERE folio IS NULL;

-- La secuencia arranca después del id más alto, para que un folio nuevo nunca choque con uno de esos.
SELECT setval(
  'reports_folio_seq',
  GREATEST(COALESCE((SELECT MAX("UniqueID") FROM reports), 0), 1),
  COALESCE((SELECT MAX("UniqueID") FROM reports), 0) > 0
);

ALTER TABLE reports
  ALTER COLUMN folio SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reports_folio_unique
  ON reports (folio);

-- Un reintento con el mismo client_uuid devuelve el reporte original en vez de crear otro.
CREATE UNIQUE INDEX IF NOT EXISTS reports_reporter_client_uuid_unique
  ON reports (reporter_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS reports_status_created_idx
  ON reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS reports_reporter_idx
  ON reports (reporter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS reports_request_idx
  ON reports (request_id);

-- Notas internas de Soporte: no las ve quien reportó.
ALTER TABLE reports_events
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS reports_events_report_idx
  ON reports_events (report_id, "UniqueID");

CREATE INDEX IF NOT EXISTS report_attachments_report_idx
  ON report_attachments (report_id);
