import crypto from 'node:crypto';

import { ENV } from '../config/env.ts';

/**
 * API-57: cifrado de campos sensibles en la base (RFC, identificación fiscal) con AES-256-GCM.
 *
 * Formato guardado: `enc:v1:<iv>:<etiqueta>:<cifrado>` en base64url. GCM comprueba la etiqueta al
 * descifrar, así que un valor alterado o una llave equivocada fallan en lugar de dar basura.
 *
 * Un valor cifrado cambia cada vez (iv aleatorio), así que no se puede buscar ni exigir único. Para
 * eso está el índice ciego: un HMAC del valor normalizado, siempre igual para el mismo valor.
 *
 * Las dos llaves (cifrado e índice) se derivan con HKDF de DATA_ENCRYPTION_KEY. Si esa llave se
 * pierde, los datos cifrados no se pueden recuperar: hay que respaldarla aparte de la base.
 */

const PREFIX = 'enc:v1:';
const MIN_KEY_LENGTH = 32;
/** Solo fuera de producción, para no tener que configurar nada al desarrollar. */
const DEVELOPMENT_KEY = 'fixora-llave-de-desarrollo-no-usar-en-produccion';

export interface FieldCipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
  blindIndex(normalized: string): string;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

function deriveKey(master: string, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, 'fixora', purpose, 32));
}

export function createFieldCipher(masterKey: string): FieldCipher {
  if (masterKey.length < MIN_KEY_LENGTH) {
    throw new Error(`La llave de cifrado debe tener al menos ${MIN_KEY_LENGTH} caracteres.`);
  }
  const encryptionKey = deriveKey(masterKey, 'campos-cifrados');
  const indexKey = deriveKey(masterKey, 'indice-ciego');

  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
    },
    decrypt(stored) {
      if (!isEncrypted(stored)) throw new Error('El valor no está cifrado.');
      const [iv, tag, data] = stored.slice(PREFIX.length).split(':');
      if (!iv || !tag || data === undefined) throw new Error('El valor cifrado está incompleto.');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        encryptionKey,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
    blindIndex(normalized) {
      return crypto.createHmac('sha256', indexKey).update(normalized, 'utf8').digest('hex');
    },
  };
}

/** La llave de DATA_ENCRYPTION_KEY; en producción es obligatoria. */
export function resolveEncryptionKey(value: string | undefined, isProduction: boolean): string {
  if (value && value.length >= MIN_KEY_LENGTH) return value;
  if (isProduction) {
    throw new Error(
      `DATA_ENCRYPTION_KEY es obligatoria en producción y debe tener al menos ${MIN_KEY_LENGTH} caracteres.`,
    );
  }
  console.warn('[Cifrado] Falta DATA_ENCRYPTION_KEY; se usa la llave de desarrollo.');
  return DEVELOPMENT_KEY;
}

let masterKey: string | undefined;
let defaultCipher: FieldCipher | undefined;
let defaultFileCipher: FileCipher | undefined;

function appMasterKey(): string {
  masterKey ??= resolveEncryptionKey(ENV.DATA_ENCRYPTION_KEY, ENV.NODE_ENV === 'production');
  return masterKey;
}

/** El cifrador de la app, creado la primera vez que se usa. */
export function fieldCipher(): FieldCipher {
  defaultCipher ??= createFieldCipher(appMasterKey());
  return defaultCipher;
}

/**
 * API-58: archivos cifrados en disco. Formato: la marca `FXENC1`, el iv (12 bytes), la etiqueta
 * (16 bytes) y el contenido cifrado, que mide lo mismo que el original. La marca distingue un
 * archivo cifrado de uno de antes, que se sigue sirviendo tal cual.
 */
const FILE_MAGIC = Buffer.from('FXENC1', 'latin1');
const FILE_IV_BYTES = 12;
const FILE_TAG_BYTES = 16;
export const ENCRYPTED_FILE_OVERHEAD = FILE_MAGIC.length + FILE_IV_BYTES + FILE_TAG_BYTES;

export interface FileCipher {
  encrypt(plain: Buffer): Buffer;
  decrypt(stored: Buffer): Buffer;
}

/** Si los primeros bytes de un archivo son los de uno cifrado. */
export function isEncryptedFile(head: Buffer): boolean {
  return head.length >= FILE_MAGIC.length && head.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);
}

export function createFileCipher(master: string): FileCipher {
  if (master.length < MIN_KEY_LENGTH) {
    throw new Error(`La llave de cifrado debe tener al menos ${MIN_KEY_LENGTH} caracteres.`);
  }
  const key = deriveKey(master, 'archivos-cifrados');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(FILE_IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), data]);
    },
    decrypt(stored) {
      if (!isEncryptedFile(stored) || stored.length < ENCRYPTED_FILE_OVERHEAD) {
        throw new Error('El archivo no está cifrado o está incompleto.');
      }
      const ivStart = FILE_MAGIC.length;
      const tagStart = ivStart + FILE_IV_BYTES;
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        stored.subarray(ivStart, tagStart),
      );
      decipher.setAuthTag(stored.subarray(tagStart, ENCRYPTED_FILE_OVERHEAD));
      return Buffer.concat([
        decipher.update(stored.subarray(ENCRYPTED_FILE_OVERHEAD)),
        decipher.final(),
      ]);
    },
  };
}

/** El cifrador de archivos de la app (misma DATA_ENCRYPTION_KEY, otra llave derivada). */
export function fileCipher(): FileCipher {
  defaultFileCipher ??= createFileCipher(appMasterKey());
  return defaultFileCipher;
}
