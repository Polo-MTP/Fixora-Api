import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import { storageService } from '../storage.service.ts';
import { storageController } from '../../controllers/storage.controller.ts';
import { AppError } from '../../errors/app-error.ts';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeFile(mimetype: string, originalname: string, buffer: Buffer): Express.Multer.File {
  return { mimetype, originalname, buffer, size: buffer.length } as Express.Multer.File;
}

/** Ejecuta deleteFile y regresa el error que recibe next (o null si no hubo). */
async function deleteAs(userId: string, role: string, fileKey: string): Promise<AppError | null> {
  const req = {
    body: { file_key: fileKey },
    query: {},
    user: { id: userId, role },
  } as unknown as Request;
  const res = { status: () => res, json: () => res } as unknown as Response;
  let received: unknown = null;
  const next: NextFunction = (err?: unknown) => {
    received = err ?? null;
  };
  await storageController.deleteFile(req, res, next);
  return received as AppError | null;
}

describe('Almacenamiento: dueño de cada archivo', () => {
  it('la llave incluye el id de quien lo sube', () => {
    assert.match(
      storageService.generateFileKey('photos', 'Foto.PNG', '16'),
      /^photos\/16\/\d{4}\/\d{2}\/.+\.png$/,
    );
    assert.match(
      storageService.generateFileKey('documents', 'ine.pdf', '16', true),
      /^documents\/verification\/16\/\d{4}\/\d{2}\/.+\.pdf$/,
    );
  });

  it('lee el dueño desde la llave', () => {
    assert.equal(storageService.getFileOwnerId('photos/16/2026/11/a.png'), '16');
    assert.equal(storageService.getFileOwnerId('documents/verification/7/2026/11/a.pdf'), '7');
    // Llave sin dueño: el año no cuenta como id de usuario.
    assert.equal(storageService.getFileOwnerId('photos/2026/11/a.png'), null);
    assert.equal(storageService.getFileOwnerId('photos/abc/a.png'), null);
  });

  it('otro usuario no puede borrar el archivo (403)', async () => {
    const error = await deleteAs('17', 'cliente', 'photos/16/2026/11/no-existe.png');
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'FILE_DELETE_FORBIDDEN');
  });

  it('un cliente no puede borrar documentos de verificación, ni los suyos (403)', async () => {
    const error = await deleteAs(
      '16',
      'cliente',
      'documents/verification/16/2026/11/no-existe.pdf',
    );
    assert.equal(error?.statusCode, 403);
  });

  it('el dueño y el administrador sí pasan el permiso (404 porque el archivo no existe)', async () => {
    assert.equal(
      (await deleteAs('16', 'cliente', 'photos/16/2026/11/no-existe.png'))?.statusCode,
      404,
    );
    assert.equal(
      (await deleteAs('1', 'administrador', 'photos/16/2026/11/no-existe.png'))?.statusCode,
      404,
    );
  });
});

describe('Almacenamiento: contenido del archivo', () => {
  it('acepta un PNG real', () => {
    assert.doesNotThrow(() =>
      storageService.validateFile(fakeFile('image/png', 'a.png', PNG_HEADER), 'photos'),
    );
  });

  it('rechaza texto disfrazado de PNG', () => {
    assert.throws(
      () =>
        storageService.validateFile(
          fakeFile('image/png', 'a.png', Buffer.from('no soy imagen')),
          'photos',
        ),
      (err: unknown) => err instanceof AppError && err.code === 'FILE_CONTENT_MISMATCH',
    );
  });

  it('no firma llaves que intentan salir del almacenamiento', () => {
    assert.throws(
      () => storageService.generateSignedUrl({ file_key: '../.env' }, 'administrador'),
      (err: unknown) => err instanceof AppError && err.statusCode === 403,
    );
  });
});
