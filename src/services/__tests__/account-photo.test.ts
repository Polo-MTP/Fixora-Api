import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase } from '../../config/database.ts';
import { updateMyPhoto } from '../account.service.ts';
import { BadRequestError } from '../../errors/app-error.ts';

describe('API-10: Foto de perfil de la cuenta (updateMyPhoto)', () => {
  it('pide una llave de texto o null', async () => {
    for (const value of [undefined, 12, '   ', {}]) {
      await assert.rejects(
        () => updateMyPhoto(7n, value),
        (err: unknown) => err instanceof BadRequestError,
        String(value),
      );
    }
  });

  it('rechaza fotos de otro usuario, documentos y rutas manipuladas (antes de tocar la base)', async () => {
    for (const key of [
      'photos/8/2026/11/ajena.jpg',
      'documents/verification/7/2026/11/ine.jpg',
      'photos/7/../../documents/verification/8/ine.jpg',
    ]) {
      await assert.rejects(
        () => updateMyPhoto(7n, key),
        (err: unknown) => (err as BadRequestError).code === 'INVALID_PHOTO_KEY',
        key,
      );
    }
  });

  after(async () => {
    await closeDatabase();
  });
});
