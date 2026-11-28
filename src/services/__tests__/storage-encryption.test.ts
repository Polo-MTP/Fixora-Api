import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { storageService } from '../storage.service.ts';
import {
  ENCRYPTED_FILE_OVERHEAD,
  createFileCipher,
  isEncryptedFile,
} from '../../utils/field-encryption.ts';

const KEY = 'llave-de-prueba-de-al-menos-32-caracteres';
const PDF = Buffer.from('%PDF-1.4\nprueba API-58\n%%EOF\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const OWNER = '999999';

function fakeFile(mimetype: string, originalname: string, buffer: Buffer): Express.Multer.File {
  return { mimetype, originalname, buffer, size: buffer.length } as Express.Multer.File;
}

const created: string[] = [];
after(async () => {
  for (const key of created) await storageService.deleteFile(key);
  // Las carpetas del dueño de prueba, que quedan vacías.
  for (const dir of ['photos', 'documents', 'documents/verification']) {
    fs.rmSync(storageService.resolveSafePath(`${dir}/${OWNER}`), { recursive: true, force: true });
  }
});

describe('API-58: cifrado de archivos', () => {
  it('cifra y descifra igual al original; lleva la marca y mide lo mismo más el encabezado', () => {
    const cipher = createFileCipher(KEY);
    const stored = cipher.encrypt(PDF);
    assert.ok(isEncryptedFile(stored));
    assert.ok(!isEncryptedFile(PDF));
    assert.equal(stored.length, PDF.length + ENCRYPTED_FILE_OVERHEAD);
    assert.ok(!stored.includes(Buffer.from('prueba API-58')));
    assert.deepEqual(cipher.decrypt(stored), PDF);
  });

  it('una llave equivocada o un archivo alterado no se descifran', () => {
    const stored = createFileCipher(KEY).encrypt(PDF);
    assert.throws(() => createFileCipher(`${KEY}-otra`).decrypt(stored));
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    assert.throws(() => createFileCipher(KEY).decrypt(tampered));
    assert.throws(() => createFileCipher(KEY).decrypt(PDF), /no está cifrado/);
  });
});

describe('API-58: documentos cifrados en el almacenamiento', () => {
  it('un documento se guarda cifrado y se lee igual; el hash es del original', async () => {
    const saved = await storageService.saveUploadedFile(
      fakeFile('application/pdf', 'ine.pdf', PDF),
      'documents',
      OWNER,
      true,
    );
    created.push(saved.file_key);

    const info = await storageService.getFileForDownload(saved.file_key);
    assert.equal(info.encrypted, true);
    assert.equal(info.sizeBytes, PDF.length);
    assert.ok(isEncryptedFile(fs.readFileSync(info.fullPath)));
    assert.deepEqual(await storageService.readFileContent(saved.file_key), PDF);
    assert.equal(saved.file_hash, crypto.createHash('sha256').update(PDF).digest('hex'));
  });

  it('las fotos se guardan sin cifrar', async () => {
    const saved = await storageService.saveUploadedFile(
      fakeFile('image/png', 'foto.png', PNG),
      'photos',
      OWNER,
    );
    created.push(saved.file_key);
    const info = await storageService.getFileForDownload(saved.file_key);
    assert.equal(info.encrypted, false);
    assert.deepEqual(fs.readFileSync(info.fullPath), PNG);
  });

  it('un documento de antes se cifra en su lugar una sola vez y se sigue leyendo igual', async () => {
    const key = storageService.generateFileKey('documents', 'viejo.pdf', OWNER);
    const fullPath = storageService.resolveSafePath(key);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, PDF);
    created.push(key);

    assert.equal((await storageService.getFileForDownload(key)).encrypted, false);
    assert.deepEqual(await storageService.readFileContent(key), PDF);
    assert.ok((await storageService.listDocumentKeys()).includes(key));

    assert.equal(await storageService.encryptExistingFile(key), true);
    assert.equal(await storageService.encryptExistingFile(key), false);
    assert.equal((await storageService.getFileForDownload(key)).encrypted, true);
    assert.deepEqual(await storageService.readFileContent(key), PDF);
    assert.equal(fs.existsSync(`${fullPath}.cifrando`), false);
  });
});
