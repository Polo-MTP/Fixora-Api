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

let defaultCipher: FieldCipher | undefined;

/** El cifrador de la app, creado la primera vez que se usa. */
export function fieldCipher(): FieldCipher {
  defaultCipher ??= createFieldCipher(
    resolveEncryptionKey(ENV.DATA_ENCRYPTION_KEY, ENV.NODE_ENV === 'production'),
  );
  return defaultCipher;
}
