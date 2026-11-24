import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  formatReviewAuthor,
  parseCreateReviewInput,
  parseReviewPageQuery,
} from '../../utils/review-validation.ts';

const UUID = '3f2b8c1e-5a47-4d0b-9c1a-7e6f2d4b8a10';

describe('validación de reseñas (API-39)', () => {
  describe('parseCreateReviewInput', () => {
    it('acepta solo las estrellas', () => {
      const input = parseCreateReviewInput({ rating: 5 });
      assert.deepEqual(input, {
        rating: 5,
        comment: null,
        attachment_keys: [],
        client_uuid: null,
      });
    });

    it('acepta comentario, evidencia y client_uuid', () => {
      const input = parseCreateReviewInput({
        rating: 3,
        comment: '  Llegó tarde pero resolvió  ',
        attachment_keys: ['photos/42/2026/11/a.jpg', 'evidences/42/2026/11/b.mp4'],
        client_uuid: UUID.toUpperCase(),
      });
      assert.equal(input.comment, 'Llegó tarde pero resolvió');
      assert.equal(input.attachment_keys.length, 2);
      assert.equal(input.client_uuid, UUID);
    });

    it('trata un comentario vacío como sin comentario', () => {
      assert.equal(parseCreateReviewInput({ rating: 4, comment: '   ' }).comment, null);
    });

    it('solo acepta estrellas enteras de 1 a 5', () => {
      for (const rating of [0, 6, -1, 4.5, '5', null, undefined, NaN]) {
        assert.throws(() => parseCreateReviewInput({ rating }), BadRequestError, String(rating));
      }
      for (const rating of [1, 2, 3, 4, 5]) {
        assert.equal(parseCreateReviewInput({ rating }).rating, rating);
      }
    });

    it('rechaza comentarios de más de 1000 caracteres', () => {
      assert.throws(
        () => parseCreateReviewInput({ rating: 5, comment: 'a'.repeat(1001) }),
        BadRequestError,
      );
      assert.doesNotThrow(() => parseCreateReviewInput({ rating: 5, comment: 'a'.repeat(1000) }));
    });

    it('limita la evidencia a 3 archivos sin repetir ni vacíos', () => {
      const keys = ['photos/1/a.jpg', 'photos/1/b.jpg', 'photos/1/c.jpg', 'photos/1/d.jpg'];
      assert.throws(
        () => parseCreateReviewInput({ rating: 5, attachment_keys: keys }),
        BadRequestError,
      );
      assert.throws(
        () =>
          parseCreateReviewInput({
            rating: 5,
            attachment_keys: ['photos/1/a.jpg', 'photos/1/a.jpg'],
          }),
        BadRequestError,
      );
      assert.throws(
        () => parseCreateReviewInput({ rating: 5, attachment_keys: [''] }),
        BadRequestError,
      );
    });

    it('rechaza client_uuid inválido, campos desconocidos y cuerpos que no son objetos', () => {
      assert.throws(
        () => parseCreateReviewInput({ rating: 5, client_uuid: 'no-es-uuid' }),
        BadRequestError,
      );
      assert.throws(
        () => parseCreateReviewInput({ rating: 5, direction: 'cliente_a_proveedor' }),
        BadRequestError,
      );
      assert.throws(() => parseCreateReviewInput(null), BadRequestError);
      assert.throws(() => parseCreateReviewInput([]), BadRequestError);
    });
  });

  describe('parseReviewPageQuery', () => {
    it('usa página 1 y 10 reseñas por defecto', () => {
      assert.deepEqual(parseReviewPageQuery({}), { page: 1, limit: 10 });
    });

    it('acepta page y limit válidos y rechaza los inválidos', () => {
      assert.deepEqual(parseReviewPageQuery({ page: '3', limit: '50' }), { page: 3, limit: 50 });
      assert.throws(() => parseReviewPageQuery({ page: '0' }), BadRequestError);
      assert.throws(() => parseReviewPageQuery({ limit: '51' }), BadRequestError);
      assert.throws(() => parseReviewPageQuery({ limit: 'diez' }), BadRequestError);
    });
  });

  describe('formatReviewAuthor', () => {
    it('publica el nombre con la inicial del apellido', () => {
      assert.equal(formatReviewAuthor('Roberto', 'Martínez', 'Cliente'), 'Roberto M.');
    });

    it('usa el texto de respaldo si no hay nombre', () => {
      assert.equal(formatReviewAuthor(null, 'Martínez', 'Cliente'), 'Cliente');
      assert.equal(formatReviewAuthor('  ', undefined, 'Proveedor'), 'Proveedor');
    });

    it('funciona sin apellido', () => {
      assert.equal(formatReviewAuthor('Ana', null, 'Cliente'), 'Ana');
    });
  });
});
