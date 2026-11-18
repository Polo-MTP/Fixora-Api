-- API-10: foto de perfil de la cuenta (por ejemplo, el cliente). La foto de los técnicos sigue en
-- employee_profiles. Se escribe a mano como las migraciones 0004 a 0009: drizzle-kit generate
-- repetiría cambios que esas ya aplicaron, porque no actualizaron los snapshots.
ALTER TABLE "personal_data" ADD COLUMN IF NOT EXISTS "photo_key" varchar(500);
