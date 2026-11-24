import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  chatPreview,
  parseChatPageQuery,
  parseMarkReadInput,
  parseSendMessageInput,
} from '../../utils/chat-validation.ts';

const UUID = '3f2b8c1e-5a47-4d0b-9c1a-7e6f2d4b8a10';

describe('validación del chat por solicitud (API-35)', () => {
  describe('parseSendMessageInput', () => {
    it('acepta solo texto y recorta espacios', () => {
      const input = parseSendMessageInput({ client_uuid: UUID, message: '  Hola  ' });
      assert.equal(input.message, 'Hola');
      assert.deepEqual(input.attachment_keys, []);
      assert.equal(input.reply_to_id, null);
    });

    it('acepta solo fotos, sin texto', () => {
      const input = parseSendMessageInput({
        client_uuid: UUID,
        attachment_keys: ['photos/42/2026/11/a.jpg'],
      });
      assert.equal(input.message, null);
      assert.equal(input.attachment_keys.length, 1);
    });

    it('acepta la respuesta a otro mensaje', () => {
      const input = parseSendMessageInput({ client_uuid: UUID, message: 'ok', reply_to_id: '15' });
      assert.equal(input.reply_to_id, 15n);
    });

    it('normaliza el client_uuid a minúsculas', () => {
      const input = parseSendMessageInput({ client_uuid: UUID.toUpperCase(), message: 'ok' });
      assert.equal(input.client_uuid, UUID);
    });

    it('rechaza un mensaje sin texto ni fotos', () => {
      assert.throws(() => parseSendMessageInput({ client_uuid: UUID }), BadRequestError);
      assert.throws(
        () => parseSendMessageInput({ client_uuid: UUID, message: '   ', attachment_keys: [] }),
        BadRequestError,
      );
    });

    it('exige un client_uuid válido', () => {
      assert.throws(() => parseSendMessageInput({ message: 'hola' }), BadRequestError);
      assert.throws(
        () => parseSendMessageInput({ client_uuid: 'no-es-uuid', message: 'hola' }),
        BadRequestError,
      );
    });

    it('rechaza textos de más de 2000 caracteres', () => {
      assert.throws(
        () => parseSendMessageInput({ client_uuid: UUID, message: 'a'.repeat(2001) }),
        BadRequestError,
      );
      assert.doesNotThrow(() =>
        parseSendMessageInput({ client_uuid: UUID, message: 'a'.repeat(2000) }),
      );
    });

    it('limita a 5 fotos y rechaza llaves repetidas o vacías', () => {
      const keys = Array.from({ length: 6 }, (_, i) => `photos/42/2026/11/${i}.jpg`);
      assert.throws(
        () => parseSendMessageInput({ client_uuid: UUID, attachment_keys: keys }),
        BadRequestError,
      );
      assert.throws(
        () =>
          parseSendMessageInput({
            client_uuid: UUID,
            attachment_keys: ['photos/42/a.jpg', 'photos/42/a.jpg'],
          }),
        BadRequestError,
      );
      assert.throws(
        () => parseSendMessageInput({ client_uuid: UUID, attachment_keys: [''] }),
        BadRequestError,
      );
    });

    it('rechaza campos desconocidos y reply_to_id inválido', () => {
      assert.throws(
        () => parseSendMessageInput({ client_uuid: UUID, message: 'x', sender_id: '1' }),
        BadRequestError,
      );
      assert.throws(
        () => parseSendMessageInput({ client_uuid: UUID, message: 'x', reply_to_id: '0' }),
        BadRequestError,
      );
    });

    it('rechaza cuerpos que no son objetos', () => {
      assert.throws(() => parseSendMessageInput(null), BadRequestError);
      assert.throws(() => parseSendMessageInput([]), BadRequestError);
    });
  });

  describe('parseMarkReadInput', () => {
    it('permite marcar todo sin cuerpo', () => {
      assert.deepEqual(parseMarkReadInput(undefined), { upTo: null });
      assert.deepEqual(parseMarkReadInput({}), { upTo: null });
    });

    it('acepta up_to_message_id y rechaza valores inválidos', () => {
      assert.deepEqual(parseMarkReadInput({ up_to_message_id: '99' }), { upTo: 99n });
      assert.throws(() => parseMarkReadInput({ up_to_message_id: 'abc' }), BadRequestError);
      assert.throws(() => parseMarkReadInput({ otro: 1 }), BadRequestError);
    });
  });

  describe('parseChatPageQuery', () => {
    it('usa 30 mensajes por defecto', () => {
      assert.deepEqual(parseChatPageQuery({}), { limit: 30, before: null, after: null });
    });

    it('acepta limit, before y after válidos', () => {
      assert.deepEqual(parseChatPageQuery({ limit: '50', before: '200' }), {
        limit: 50,
        before: 200n,
        after: null,
      });
      assert.equal(parseChatPageQuery({ after: '10' }).after, 10n);
    });

    it('rechaza limit fuera de rango y before junto con after', () => {
      assert.throws(() => parseChatPageQuery({ limit: '0' }), BadRequestError);
      assert.throws(() => parseChatPageQuery({ limit: '101' }), BadRequestError);
      assert.throws(() => parseChatPageQuery({ limit: 'diez' }), BadRequestError);
      assert.throws(() => parseChatPageQuery({ before: '5', after: '3' }), BadRequestError);
    });
  });

  describe('chatPreview', () => {
    it('devuelve el texto o lo recorta a 100 caracteres', () => {
      assert.equal(chatPreview('Ya voy para allá', 0), 'Ya voy para allá');
      const long = chatPreview('a'.repeat(300), 0);
      assert.equal(long.length, 100);
      assert.ok(long.endsWith('...'));
    });

    it('describe los mensajes que solo traen fotos', () => {
      assert.equal(chatPreview(null, 1), 'Te envió una fotografía.');
      assert.equal(chatPreview(null, 3), 'Te envió fotografías.');
    });
  });
});
