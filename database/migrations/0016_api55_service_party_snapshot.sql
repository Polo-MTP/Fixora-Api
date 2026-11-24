-- API-55: copia de los datos del técnico y del cliente al aceptar la solicitud.
-- El detalle muestra lo que cada quien vio al aceptar, aunque después se edite el perfil,
-- y queda como historial si hay una queja.
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS technician_name varchar(255),
  ADD COLUMN IF NOT EXISTS technician_photo_key varchar(500),
  ADD COLUMN IF NOT EXISTS vehicle_plate varchar(50),
  ADD COLUMN IF NOT EXISTS vehicle_brand varchar(100),
  ADD COLUMN IF NOT EXISTS vehicle_model varchar(100),
  ADD COLUMN IF NOT EXISTS vehicle_color varchar(50),
  ADD COLUMN IF NOT EXISTS client_name varchar(255);
