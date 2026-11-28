/**
 * API-58: cifra los documentos que se subieron antes de que se guardaran cifrados.
 *
 *   node src/scripts/encrypt-documents.ts --dry-run   # solo cuenta, no cambia nada
 *   node src/scripts/encrypt-documents.ts             # cifra
 *
 * Usa la misma DATA_ENCRYPTION_KEY que la API: correrlo con la llave equivocada deja documentos que
 * la API no puede abrir. Respaldar la carpeta de documentos antes. Se puede correr varias veces:
 * los que ya están cifrados se saltan.
 */
import { storageService } from '../services/storage.service.ts';

const dryRun = process.argv.includes('--dry-run');
const keys = await storageService.listDocumentKeys();

let alreadyEncrypted = 0;
let encrypted = 0;
let pending = 0;
let failed = 0;

for (const key of keys) {
  const info = await storageService.getFileForDownload(key);
  if (info.encrypted) {
    alreadyEncrypted += 1;
    continue;
  }
  if (dryRun) {
    pending += 1;
    continue;
  }
  try {
    if (await storageService.encryptExistingFile(key)) encrypted += 1;
    else alreadyEncrypted += 1;
  } catch (error) {
    failed += 1;
    console.error(`[Cifrado] No se pudo cifrar ${key}:`, error);
  }
}

console.log(
  dryRun
    ? `[Cifrado] Documentos: ${keys.length}. Ya cifrados: ${alreadyEncrypted}. Por cifrar: ${pending}. (Sin cambios: --dry-run)`
    : `[Cifrado] Documentos: ${keys.length}. Cifrados ahora: ${encrypted}. Ya estaban: ${alreadyEncrypted}. Con error: ${failed}.`,
);
process.exit(failed ? 1 : 0);
