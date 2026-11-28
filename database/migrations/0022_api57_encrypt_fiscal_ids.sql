-- API-57: el RFC del proveedor y la identificación fiscal del negocio se guardan cifrados
-- (AES-256-GCM, ver src/services/fiscal-id.service.ts). El valor cifrado cambia cada vez, así que
-- el único pasa a un índice ciego (HMAC del valor). Los datos que ya existen los cifra la API al
-- arrancar; hasta entonces se leen tal cual.
-- Se puede correr más de una vez (en desarrollo se aplicó antes como 0017).
ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS "suppliers_rfc_unique";--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "rfc" TYPE text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "rfc_hash" varchar(64);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_rfc_hash_unique') THEN
    ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_rfc_hash_unique" UNIQUE("rfc_hash");
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "business" DROP CONSTRAINT IF EXISTS "business_tax_identification_unique";--> statement-breakpoint
ALTER TABLE "business" ALTER COLUMN "tax_identification" TYPE text;--> statement-breakpoint
ALTER TABLE "business" ADD COLUMN IF NOT EXISTS "tax_identification_hash" varchar(64);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_tax_identification_hash_unique') THEN
    ALTER TABLE "business" ADD CONSTRAINT "business_tax_identification_hash_unique" UNIQUE("tax_identification_hash");
  END IF;
END $$;
