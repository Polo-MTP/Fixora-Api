import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  DEFAULT_AUTO_MARK_THRESHOLD,
  autoMarkReason,
  buildClientAlertMessage,
  formatSanctionDate,
  isSanctionCurrent,
  notifiesUser,
  parseApplySanctionInput,
  parseLiftSanctionInput,
  parseSanctionListQuery,
  sanctionStatus,
  shouldAutoMark,
} from '../../utils/sanction-validation.ts';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const IN_7_DAYS = '2026-12-01T12:00:00.000Z';

describe('sanciones y marcas de usuarios problemáticos (API-42)', () => {
  describe('parseApplySanctionInput', () => {
    it('acepta una restricción temporal con fecha de fin y reporte', () => {
      const input = parseApplySanctionInput(
        {
          user_id: '20',
          type: 'restriccion_temporal',
          reason: '  Cancelaciones repetidas a última hora  ',
          ends_at: IN_7_DAYS,
          report_id: '45',
        },
        NOW,
      );
      assert.equal(input.user_id, 20n);
      assert.equal(input.type, 'restriccion_temporal');
      assert.equal(input.reason, 'Cancelaciones repetidas a última hora');
      assert.equal(input.ends_at?.toISOString(), IN_7_DAYS);
      assert.equal(input.report_id, 45n);
    });

    it('las marcas pueden no vencer', () => {
      for (const type of ['baja_reputacion', 'usuario_problematico']) {
        const input = parseApplySanctionInput(
          { user_id: '20', type, reason: 'Comportamiento reiterado' },
          NOW,
        );
        assert.equal(input.ends_at, null);
        assert.equal(input.report_id, null);
      }
    });

    it('la restricción temporal exige fecha de fin', () => {
      assert.throws(
        () =>
          parseApplySanctionInput(
            { user_id: '20', type: 'restriccion_temporal', reason: 'Motivo válido' },
            NOW,
          ),
        BadRequestError,
      );
    });

    it('la fecha de fin debe ser futura y la restricción no pasa de 365 días', () => {
      const base = { user_id: '20', type: 'restriccion_temporal', reason: 'Motivo válido' };
      assert.throws(
        () => parseApplySanctionInput({ ...base, ends_at: '2026-11-01T00:00:00Z' }, NOW),
        BadRequestError,
      );
      assert.throws(
        () => parseApplySanctionInput({ ...base, ends_at: '2028-01-01T00:00:00Z' }, NOW),
        BadRequestError,
      );
      assert.doesNotThrow(() =>
        parseApplySanctionInput({ ...base, ends_at: '2027-11-20T00:00:00Z' }, NOW),
      );
    });

    it('una marca con fecha de fin pasada también se rechaza', () => {
      assert.throws(
        () =>
          parseApplySanctionInput(
            {
              user_id: '20',
              type: 'baja_reputacion',
              reason: 'Motivo válido',
              ends_at: '2026-01-01T00:00:00Z',
            },
            NOW,
          ),
        BadRequestError,
      );
    });

    it('rechaza datos inválidos', () => {
      const base = { user_id: '20', type: 'baja_reputacion', reason: 'Motivo válido' };
      assert.throws(
        () => parseApplySanctionInput({ ...base, type: 'baneo' }, NOW),
        BadRequestError,
      );
      assert.throws(
        () => parseApplySanctionInput({ ...base, user_id: 'abc' }, NOW),
        BadRequestError,
      );
      assert.throws(
        () => parseApplySanctionInput({ ...base, user_id: undefined }, NOW),
        BadRequestError,
      );
      assert.throws(() => parseApplySanctionInput({ ...base, reason: 'no' }, NOW), BadRequestError);
      assert.throws(
        () => parseApplySanctionInput({ ...base, reason: 'a'.repeat(1001) }, NOW),
        BadRequestError,
      );
      assert.throws(
        () => parseApplySanctionInput({ ...base, ends_at: 'mañana' }, NOW),
        BadRequestError,
      );
      assert.throws(
        () => parseApplySanctionInput({ ...base, report_id: '0' }, NOW),
        BadRequestError,
      );
      assert.throws(
        () => parseApplySanctionInput({ ...base, created_by: '1' }, NOW),
        BadRequestError,
      );
      assert.throws(() => parseApplySanctionInput(null, NOW), BadRequestError);
    });
  });

  describe('parseLiftSanctionInput', () => {
    it('exige el motivo', () => {
      assert.deepEqual(parseLiftSanctionInput({ reason: '  Se revisó y no procede  ' }), {
        reason: 'Se revisó y no procede',
      });
      assert.throws(() => parseLiftSanctionInput({}), BadRequestError);
      assert.throws(() => parseLiftSanctionInput({ reason: 'ok' }), BadRequestError);
      assert.throws(
        () => parseLiftSanctionInput({ reason: 'Motivo válido', x: 1 }),
        BadRequestError,
      );
    });
  });

  describe('parseSanctionListQuery', () => {
    it('usa página 1 y 20 por defecto', () => {
      assert.deepEqual(parseSanctionListQuery({}), {
        page: 1,
        limit: 20,
        user_id: null,
        type: null,
        status: null,
      });
    });

    it('acepta filtros válidos y rechaza los inválidos', () => {
      const query = parseSanctionListQuery({
        page: '2',
        limit: '50',
        user_id: '20',
        type: 'usuario_problematico',
        status: 'vigente',
      });
      assert.equal(query.user_id, 20n);
      assert.equal(query.type, 'usuario_problematico');
      assert.equal(query.status, 'vigente');
      assert.throws(() => parseSanctionListQuery({ status: 'activa' }), BadRequestError);
      assert.throws(() => parseSanctionListQuery({ type: 'x' }), BadRequestError);
      assert.throws(() => parseSanctionListQuery({ limit: '101' }), BadRequestError);
      assert.throws(() => parseSanctionListQuery({ page: '0' }), BadRequestError);
    });
  });

  describe('vigencia', () => {
    const start = new Date('2026-11-20T00:00:00Z');

    it('vigente, vencida o retirada según el caso', () => {
      assert.equal(
        sanctionStatus({ active: true, starts_at: start, ends_at: null }, NOW),
        'vigente',
      );
      assert.equal(
        sanctionStatus({ active: true, starts_at: start, ends_at: new Date(IN_7_DAYS) }, NOW),
        'vigente',
      );
      assert.equal(
        sanctionStatus(
          { active: true, starts_at: start, ends_at: new Date('2026-11-24T11:59:59Z') },
          NOW,
        ),
        'vencida',
      );
      assert.equal(
        sanctionStatus({ active: false, starts_at: start, ends_at: null }, NOW),
        'retirada',
      );
    });

    it('al llegar exactamente la fecha de fin ya no está vigente', () => {
      assert.equal(isSanctionCurrent({ active: true, starts_at: start, ends_at: NOW }, NOW), false);
    });

    it('una sanción que aún no empieza no está vigente', () => {
      const future = new Date('2026-12-01T00:00:00Z');
      assert.equal(
        isSanctionCurrent({ active: true, starts_at: future, ends_at: null }, NOW),
        false,
      );
    });
  });

  describe('regla automática', () => {
    it('el umbral por defecto es 2: se marca al tercer reporte confirmado', () => {
      assert.equal(DEFAULT_AUTO_MARK_THRESHOLD, 2);
      assert.equal(shouldAutoMark(2, 2, false), false);
      assert.equal(shouldAutoMark(3, 2, false), true);
      assert.equal(shouldAutoMark(10, 2, false), true);
    });

    it('no repite la marca si ya hay una automática vigente', () => {
      assert.equal(shouldAutoMark(5, 2, true), false);
    });

    it('respeta otro umbral', () => {
      assert.equal(shouldAutoMark(4, 4, false), false);
      assert.equal(shouldAutoMark(5, 4, false), true);
    });

    it('el motivo indica cuántos reportes confirmados hay', () => {
      assert.equal(autoMarkReason(3), 'Marca automática: 3 reportes confirmados.');
    });

    it('solo las marcas de usuario problemático son internas', () => {
      assert.equal(notifiesUser('usuario_problematico'), false);
      assert.equal(notifiesUser('restriccion_temporal'), true);
      assert.equal(notifiesUser('baja_reputacion'), true);
    });
  });

  describe('alerta al proveedor', () => {
    it('sin marca ni reportes no hay alerta', () => {
      assert.equal(
        buildClientAlertMessage({ marks: 0, confirmedReports: 0, reportsInReview: 0 }),
        null,
      );
    });

    it('describe la marca y los reportes', () => {
      assert.equal(
        buildClientAlertMessage({ marks: 1, confirmedReports: 3, reportsInReview: 0 }),
        'Este cliente tiene una marca de usuario con antecedentes, 3 reportes confirmados.',
      );
      assert.equal(
        buildClientAlertMessage({ marks: 0, confirmedReports: 1, reportsInReview: 2 }),
        'Este cliente tiene 1 reporte confirmado, 2 reportes en revisión.',
      );
      assert.equal(
        buildClientAlertMessage({ marks: 0, confirmedReports: 0, reportsInReview: 1 }),
        'Este cliente tiene 1 reporte en revisión.',
      );
    });
  });

  it('formatSanctionDate escribe la fecha para el usuario', () => {
    assert.match(formatSanctionDate(new Date('2026-12-01T18:00:00Z')), /2026/);
  });
});
