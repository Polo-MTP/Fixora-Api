import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFieldCipher,
  isEncrypted,
  resolveEncryptionKey,
} from '../../utils/field-encryption.ts';
import {
  fiscalIdHash,
  normalizeFiscalId,
  protectFiscalId,
  revealFiscalId,
} from '../fiscal-id.service.ts';

const KEY = 'llave-de-prueba-de-al-menos-32-caracteres';

describe('API-57: cifrado de campos', () => {
  it('cifra y descifra; el mismo valor sale distinto cada vez', () => {
    const cipher = createFieldCipher(KEY);
    const first = cipher.encrypt('XAXX010101000');
    const second = cipher.encrypt('XAXX010101000');
    assert.ok(isEncrypted(first));
    assert.notEqual(first, second);
    assert.ok(!first.includes('XAXX'));
    assert.equal(cipher.decrypt(first), 'XAXX010101000');
    assert.equal(cipher.decrypt(second), 'XAXX010101000');
  });

  it('el índice ciego es siempre el mismo para el mismo valor y depende de la llave', () => {
    const cipher = createFieldCipher(KEY);
    const other = createFieldCipher(`${KEY}-otra`);
    assert.equal(cipher.blindIndex('XAXX010101000'), cipher.blindIndex('XAXX010101000'));
    assert.notEqual(cipher.blindIndex('XAXX010101000'), cipher.blindIndex('XEXX010101000'));
    assert.notEqual(cipher.blindIndex('XAXX010101000'), other.blindIndex('XAXX010101000'));
    assert.match(cipher.blindIndex('XAXX010101000'), /^[0-9a-f]{64}$/);
  });

  it('una llave equivocada o un valor alterado no se descifran', () => {
    const stored = createFieldCipher(KEY).encrypt('XAXX010101000');
    assert.throws(() => createFieldCipher(`${KEY}-otra`).decrypt(stored));
    const tampered = stored.slice(0, -2) + (stored.endsWith('AA') ? 'BB' : 'AA');
    assert.throws(() => createFieldCipher(KEY).decrypt(tampered));
  });

  it('la llave es obligatoria en producción y debe ser larga', () => {
    assert.throws(() => resolveEncryptionKey(undefined, true), /DATA_ENCRYPTION_KEY/);
    assert.throws(() => resolveEncryptionKey('corta', true), /DATA_ENCRYPTION_KEY/);
    assert.equal(resolveEncryptionKey(KEY, true), KEY);
    assert.throws(() => createFieldCipher('corta'), /32 caracteres/);
  });
});

describe('API-57: RFC e identificación fiscal', () => {
  it('normaliza sin espacios y en mayúsculas', () => {
    assert.equal(normalizeFiscalId('  xaxx010101000 '), 'XAXX010101000');
    assert.equal(normalizeFiscalId('   '), null);
    assert.equal(normalizeFiscalId(null), null);
  });

  it('guarda cifrado con su índice y se lee igual, aunque venga escrito distinto', () => {
    const saved = protectFiscalId(' xaxx010101000');
    assert.ok(saved.encrypted && isEncrypted(saved.encrypted));
    assert.equal(saved.hash, fiscalIdHash('XAXX010101000 '));
    assert.equal(revealFiscalId(saved.encrypted), 'XAXX010101000');
  });

  it('sin valor no guarda nada, y lo de antes de cifrar se lee tal cual', () => {
    assert.deepEqual(protectFiscalId(''), { encrypted: null, hash: null });
    assert.equal(revealFiscalId(null), null);
    assert.equal(revealFiscalId('XAXX010101000'), 'XAXX010101000');
  });
});
