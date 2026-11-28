import { eq, sql } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { business, suppliers } from '../database/schema/tables.ts';
import { fieldCipher, isEncrypted } from '../utils/field-encryption.ts';

/**
 * API-57: RFC del proveedor e identificación fiscal del negocio, cifrados en la base. Las columnas
 * `rfc` y `tax_identification` guardan el valor cifrado y `*_hash` el índice ciego, que es el que
 * se busca y el que no se puede repetir.
 */

/** Cómo se compara una identificación fiscal: sin espacios a los lados y en mayúsculas. */
export function normalizeFiscalId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

/** Lo que se guarda: el valor cifrado y su índice ciego (o nada si no hay valor). */
export function protectFiscalId(value: string | null | undefined): {
  encrypted: string | null;
  hash: string | null;
} {
  const normalized = normalizeFiscalId(value);
  if (!normalized) return { encrypted: null, hash: null };
  const cipher = fieldCipher();
  return { encrypted: cipher.encrypt(normalized), hash: cipher.blindIndex(normalized) };
}

/** El índice ciego para buscar un valor. */
export function fiscalIdHash(value: string | null | undefined): string | null {
  const normalized = normalizeFiscalId(value);
  return normalized ? fieldCipher().blindIndex(normalized) : null;
}

/**
 * El valor para mostrar. Uno que todavía no se cifró (de antes de API-57 y antes de que corra
 * encryptLegacyFiscalIds) se regresa tal cual.
 */
export function revealFiscalId(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return isEncrypted(stored) ? fieldCipher().decrypt(stored) : stored;
}

/**
 * Cifra los RFC e identificaciones fiscales que quedaron en texto plano de antes de API-57. Corre al
 * arrancar la API; si ya no hay nada que cifrar, no hace nada. También comprueba que la llave
 * configurada abra los que ya están cifrados, para detectar una llave equivocada en cuanto arranca.
 */
export async function encryptLegacyFiscalIds(): Promise<{ suppliers: number; business: number }> {
  const pendingSuppliers = await db
    .select({ id: suppliers.UniqueID, value: suppliers.rfc })
    .from(suppliers)
    .where(
      sql`${suppliers.rfc} is not null and (${suppliers.rfc} not like 'enc:v1:%' or ${suppliers.rfc_hash} is null)`,
    );
  let supplierCount = 0;
  for (const row of pendingSuppliers) {
    const plain = revealFiscalId(row.value);
    const { encrypted, hash } = protectFiscalId(plain);
    try {
      await db
        .update(suppliers)
        .set({ rfc: encrypted, rfc_hash: hash })
        .where(eq(suppliers.UniqueID, row.id));
      supplierCount += 1;
    } catch (error) {
      console.error(`[Cifrado] No se pudo cifrar el RFC del proveedor ${row.id}:`, error);
    }
  }

  const pendingBusiness = await db
    .select({ id: business.UniqueID, value: business.tax_identification })
    .from(business)
    .where(
      sql`${business.tax_identification} is not null and (${business.tax_identification} not like 'enc:v1:%' or ${business.tax_identification_hash} is null)`,
    );
  let businessCount = 0;
  for (const row of pendingBusiness) {
    const plain = revealFiscalId(row.value);
    const { encrypted, hash } = protectFiscalId(plain);
    try {
      await db
        .update(business)
        .set({ tax_identification: encrypted, tax_identification_hash: hash })
        .where(eq(business.UniqueID, row.id));
      businessCount += 1;
    } catch (error) {
      console.error(
        `[Cifrado] No se pudo cifrar la identificación fiscal del negocio ${row.id}:`,
        error,
      );
    }
  }

  // Una llave distinta a la que cifró los datos no abre nada: mejor saberlo al arrancar.
  const [sample] = await db
    .select({ value: suppliers.rfc })
    .from(suppliers)
    .where(sql`${suppliers.rfc} like 'enc:v1:%'`)
    .limit(1);
  if (sample?.value) {
    try {
      revealFiscalId(sample.value);
    } catch {
      console.error(
        '[Cifrado] DATA_ENCRYPTION_KEY no abre los RFC guardados: no es la llave con la que se cifraron.',
      );
    }
  }

  return { suppliers: supplierCount, business: businessCount };
}
