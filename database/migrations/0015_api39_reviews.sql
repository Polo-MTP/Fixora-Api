-- API-39: reseñas bidireccionales y recálculo de promedio.

-- Fecha de la reseña (para ordenarlas y mostrarlas). Las existentes toman la fecha de la migración.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();

-- Una reseña por solicitud y por sentido (cliente a proveedor, proveedor a cliente).
CREATE UNIQUE INDEX IF NOT EXISTS reviews_request_direction_unique
  ON reviews (request_id, direction);

-- Un reintento con el mismo client_uuid devuelve la reseña original en vez de fallar.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_author_client_uuid_unique
  ON reviews (author_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

-- Estrellas de 1 a 5. NOT VALID aplica la regla a las reseñas nuevas sin revisar las que ya existen.
ALTER TABLE reviews
  ADD CONSTRAINT reviews_rating_range CHECK (rating BETWEEN 1 AND 5) NOT VALID;

CREATE INDEX IF NOT EXISTS reviews_reviewee_idx
  ON reviews (reviewee_id, direction, status);

CREATE INDEX IF NOT EXISTS review_attachments_review_idx
  ON review_attachments (review_id);

-- Promedio y total de reseñas recibidas por cada usuario (el cliente, o el técnico reseñado).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rating_avg numeric(3, 2) DEFAULT '0.00',
  ADD COLUMN IF NOT EXISTS reviews_count integer NOT NULL DEFAULT 0;

-- Calcula con lo que ya exista, para que los promedios arranquen correctos.
UPDATE users u
SET rating_avg = r.average,
    reviews_count = r.total
FROM (
  SELECT reviewee_id,
         ROUND(AVG(rating)::numeric, 2) AS average,
         COUNT(*)::int AS total
  FROM reviews
  WHERE status = 'publicada'
  GROUP BY reviewee_id
) r
WHERE u."UniqueID" = r.reviewee_id;

-- Promedio de la sucursal: reseñas de clientes sobre solicitudes atendidas por ella.
UPDATE branches b
SET rating_avg = r.average,
    reviews_count = r.total
FROM (
  SELECT sr.branch_id,
         ROUND(AVG(rv.rating)::numeric, 2) AS average,
         COUNT(*)::int AS total
  FROM reviews rv
  JOIN service_requests sr ON sr."UniqueID" = rv.request_id
  WHERE rv.direction = 'cliente_a_proveedor'
    AND rv.status = 'publicada'
    AND sr.branch_id IS NOT NULL
  GROUP BY sr.branch_id
) r
WHERE b."UniqueID" = r.branch_id;
