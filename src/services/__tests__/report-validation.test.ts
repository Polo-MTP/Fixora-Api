import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../errors/app-error.ts';
import {
  formatFolio,
  isReportClosed,
  isStaffRole,
  isValidReportTransition,
  parseAssignInput,
  parseChangeStatusInput,
  parseCommentInput,
  parseCreateReportInput,
  parseEvidenceInput,
  parseReportListQuery,
} from '../../utils/report-validation.ts';

const UUID = '3f2b8c1e-5a47-4d0b-9c1a-7e6f2d4b8a10';
const DESCRIPTION = 'El técnico no terminó la instalación.';

describe('validación de reportes, garantías y reclamaciones (API-40)', () => {
  describe('parseCreateReportInput', () => {
    it('crea un reporte por defecto', () => {
      const input = parseCreateReportInput({
        request_id: '501',
        category: 'servicio_incompleto',
        description: `  ${DESCRIPTION}  `,
      });
      assert.equal(input.request_id, 501n);
      assert.equal(input.type, 'reporte');
      assert.equal(input.description, DESCRIPTION);
      assert.deepEqual(input.attachment_keys, []);
      assert.equal(input.client_uuid, null);
    });

    it('acepta garantía y reclamación con evidencia y client_uuid', () => {
      for (const type of ['garantia', 'reclamacion'] as const) {
        const input = parseCreateReportInput({
          request_id: '501',
          type,
          category: 'danos',
          description: DESCRIPTION,
          attachment_keys: ['photos/42/2026/11/a.jpg', 'evidences/42/2026/11/b.pdf'],
          client_uuid: UUID.toUpperCase(),
        });
        assert.equal(input.type, type);
        assert.equal(input.attachment_keys.length, 2);
        assert.equal(input.client_uuid, UUID);
      }
    });

    it('rechaza datos inválidos', () => {
      const base = { request_id: '501', category: 'otro', description: DESCRIPTION };
      assert.throws(() => parseCreateReportInput({ ...base, request_id: 'abc' }), BadRequestError);
      assert.throws(
        () => parseCreateReportInput({ ...base, request_id: undefined }),
        BadRequestError,
      );
      assert.throws(() => parseCreateReportInput({ ...base, type: 'queja' }), BadRequestError);
      assert.throws(() => parseCreateReportInput({ ...base, category: 'robo' }), BadRequestError);
      assert.throws(
        () => parseCreateReportInput({ ...base, description: 'corto' }),
        BadRequestError,
      );
      assert.throws(
        () => parseCreateReportInput({ ...base, description: 'a'.repeat(2001) }),
        BadRequestError,
      );
      assert.throws(() => parseCreateReportInput({ ...base, client_uuid: 'x' }), BadRequestError);
      assert.throws(() => parseCreateReportInput({ ...base, status: 'resuelto' }), BadRequestError);
      assert.throws(() => parseCreateReportInput(null), BadRequestError);
    });

    it('limita la evidencia a 5 archivos sin repetir ni vacíos', () => {
      const base = { request_id: '501', category: 'otro', description: DESCRIPTION };
      const six = Array.from({ length: 6 }, (_, i) => `photos/1/${i}.jpg`);
      assert.throws(
        () => parseCreateReportInput({ ...base, attachment_keys: six }),
        BadRequestError,
      );
      assert.throws(
        () =>
          parseCreateReportInput({
            ...base,
            attachment_keys: ['photos/1/a.jpg', 'photos/1/a.jpg'],
          }),
        BadRequestError,
      );
      assert.throws(
        () => parseCreateReportInput({ ...base, attachment_keys: [''] }),
        BadRequestError,
      );
    });
  });

  describe('parseCommentInput', () => {
    it('acepta un comentario normal y una nota interna', () => {
      assert.deepEqual(parseCommentInput({ body: '  Hola  ' }), { body: 'Hola', internal: false });
      assert.deepEqual(parseCommentInput({ body: 'Nota', internal: true }), {
        body: 'Nota',
        internal: true,
      });
    });

    it('rechaza comentarios vacíos, muy largos o con internal inválido', () => {
      assert.throws(() => parseCommentInput({ body: '   ' }), BadRequestError);
      assert.throws(() => parseCommentInput({ body: 'a'.repeat(2001) }), BadRequestError);
      assert.throws(() => parseCommentInput({ body: 'ok', internal: 'si' }), BadRequestError);
      assert.throws(() => parseCommentInput({ body: 'ok', author_id: '1' }), BadRequestError);
    });
  });

  describe('parseEvidenceInput', () => {
    it('exige al menos una llave y como máximo 5', () => {
      assert.deepEqual(
        parseEvidenceInput({ attachment_keys: ['photos/1/a.jpg'] }).attachment_keys,
        ['photos/1/a.jpg'],
      );
      assert.throws(() => parseEvidenceInput({}), BadRequestError);
      assert.throws(() => parseEvidenceInput({ attachment_keys: [] }), BadRequestError);
      assert.throws(
        () =>
          parseEvidenceInput({
            attachment_keys: Array.from({ length: 6 }, (_, i) => `photos/1/${i}.jpg`),
          }),
        BadRequestError,
      );
    });
  });

  describe('parseChangeStatusInput', () => {
    it('pasar a revisión no pide nada más', () => {
      const input = parseChangeStatusInput({ status: 'en_revision' });
      assert.deepEqual(input, {
        status: 'en_revision',
        resolution_type: null,
        comment: null,
        priority: null,
      });
    });

    it('resolver exige resolution_type y comentario', () => {
      assert.throws(() => parseChangeStatusInput({ status: 'resuelto' }), BadRequestError);
      assert.throws(
        () => parseChangeStatusInput({ status: 'resuelto', resolution_type: 'reembolso' }),
        BadRequestError,
      );
      const input = parseChangeStatusInput({
        status: 'resuelto',
        resolution_type: 'reembolso',
        comment: 'Se reembolsó el cobro.',
        priority: 'alta',
      });
      assert.equal(input.resolution_type, 'reembolso');
      assert.equal(input.priority, 'alta');
    });

    it('rechazar exige el motivo', () => {
      assert.throws(() => parseChangeStatusInput({ status: 'rechazado' }), BadRequestError);
      assert.equal(
        parseChangeStatusInput({ status: 'rechazado', comment: 'Sin evidencia suficiente.' })
          .status,
        'rechazado',
      );
    });

    it('no admite volver a pendiente ni resolution_type fuera de resolver', () => {
      assert.throws(() => parseChangeStatusInput({ status: 'pendiente' }), BadRequestError);
      assert.throws(
        () =>
          parseChangeStatusInput({
            status: 'rechazado',
            comment: 'No procede.',
            resolution_type: 'sin_sancion',
          }),
        BadRequestError,
      );
      assert.throws(
        () => parseChangeStatusInput({ status: 'en_revision', priority: 'critica' }),
        BadRequestError,
      );
    });
  });

  describe('parseAssignInput', () => {
    it('sin cuerpo o sin assigned_to se asigna a quien llama', () => {
      assert.deepEqual(parseAssignInput(undefined), { assigned_to: null });
      assert.deepEqual(parseAssignInput({}), { assigned_to: null });
    });

    it('acepta un id válido y rechaza otros', () => {
      assert.deepEqual(parseAssignInput({ assigned_to: '12' }), { assigned_to: 12n });
      assert.throws(() => parseAssignInput({ assigned_to: 'yo' }), BadRequestError);
    });
  });

  describe('parseReportListQuery', () => {
    it('usa página 1 y 20 por defecto', () => {
      const query = parseReportListQuery({});
      assert.equal(query.page, 1);
      assert.equal(query.limit, 20);
      assert.equal(query.status, null);
    });

    it('acepta filtros válidos', () => {
      const query = parseReportListQuery({
        page: '2',
        limit: '50',
        status: 'en_revision',
        type: 'garantia',
        category: 'danos',
        priority: 'urgente',
        request_id: '501',
        assigned_to: 'me',
        q: 'gar-2026',
      });
      assert.equal(query.page, 2);
      assert.equal(query.limit, 50);
      assert.equal(query.type, 'garantia');
      assert.equal(query.request_id, 501n);
      assert.equal(query.assigned_to, 'me');
      assert.equal(query.q, 'GAR-2026');
      assert.equal(parseReportListQuery({ assigned_to: '9' }).assigned_to, 9n);
    });

    it('rechaza filtros inválidos', () => {
      assert.throws(() => parseReportListQuery({ page: '0' }), BadRequestError);
      assert.throws(() => parseReportListQuery({ limit: '101' }), BadRequestError);
      assert.throws(() => parseReportListQuery({ status: 'abierto' }), BadRequestError);
      assert.throws(() => parseReportListQuery({ q: 'REP 2026; drop' }), BadRequestError);
      assert.throws(() => parseReportListQuery({ assigned_to: 'todos' }), BadRequestError);
    });
  });

  describe('estados, roles y folio', () => {
    it('solo permite las transiciones de la máquina de estados', () => {
      assert.equal(isValidReportTransition('pendiente', 'en_revision'), true);
      assert.equal(isValidReportTransition('pendiente', 'rechazado'), true);
      assert.equal(isValidReportTransition('en_revision', 'resuelto'), true);
      assert.equal(isValidReportTransition('en_revision', 'rechazado'), true);
      assert.equal(isValidReportTransition('pendiente', 'resuelto'), false);
      assert.equal(isValidReportTransition('resuelto', 'en_revision'), false);
      assert.equal(isValidReportTransition('rechazado', 'pendiente'), false);
    });

    it('resuelto y rechazado son estados cerrados', () => {
      assert.equal(isReportClosed('resuelto'), true);
      assert.equal(isReportClosed('rechazado'), true);
      assert.equal(isReportClosed('pendiente'), false);
      assert.equal(isReportClosed('en_revision'), false);
    });

    it('Soporte y Administrador son personal de atención', () => {
      assert.equal(isStaffRole('soporte'), true);
      assert.equal(isStaffRole(' Administrador '), true);
      assert.equal(isStaffRole('cliente'), false);
      assert.equal(isStaffRole('proveedor'), false);
    });

    it('arma el folio con prefijo por tipo y seis dígitos', () => {
      assert.equal(formatFolio('reporte', 2026, '45'), 'REP-2026-000045');
      assert.equal(formatFolio('garantia', 2026, 7), 'GAR-2026-000007');
      assert.equal(formatFolio('reclamacion', 2027, '123456'), 'REC-2027-123456');
    });
  });
});
