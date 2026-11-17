import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import { closeDatabase } from '../../config/database.ts';
import { portfolioService } from '../portfolio.service.ts';
import { NON_PUBLISHABLE_DOC_PATTERN } from '../supplier-document-visibility.service.ts';
import { employeeProfileService } from '../employee-profile.service.ts';
import { supplierDocumentVisibilityController } from '../../controllers/supplier-document-visibility.controller.ts';
import { employeeProfileController } from '../../controllers/employee-profile.controller.ts';
import { BadRequestError, UnauthorizedError } from '../../errors/app-error.ts';
import type { AuthenticatedUser } from '../../middlewares/auth.middleware.ts';

const fakeAdminUser: AuthenticatedUser = {
  id: '1',
  role: 'administrador',
  sessionId: 'test-session-1',
};

describe('API-20: Reglas de Visibilidad de Documentos y Certificados', () => {
  describe('Patrón de documentos no publicables (NON_PUBLISHABLE_DOC_PATTERN)', () => {
    it('detecta y bloquea documentos de identidad oficial', () => {
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Identificación oficial vigente (INE)'), true);
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('INE anverso y reverso'), true);
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Pasaporte vigente'), true);
    });

    it('detecta y bloquea comprobantes de domicilio y fiscales', () => {
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Comprobante de domicilio reciente'), true);
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Constancia de situación fiscal'), true);
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Cédula de RFC'), true);
    });

    it('detecta y bloquea documentos legales sensibles', () => {
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Acta constitutiva de la empresa'), true);
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Poder notarial del representante'), true);
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Constancia de no antecedentes penales'), true);
    });

    it('permite certificados y diplomas técnicos de capacitación', () => {
      assert.equal(
        NON_PUBLISHABLE_DOC_PATTERN.test('Certificación DC-3 en Electricidad Industrial'),
        false,
      );
      assert.equal(
        NON_PUBLISHABLE_DOC_PATTERN.test('Diploma en Instalación de Aire Acondicionado'),
        false,
      );
      assert.equal(
        NON_PUBLISHABLE_DOC_PATTERN.test('Certificado de Manejo de Refrigerantes Ecológicos'),
        false,
      );
      assert.equal(NON_PUBLISHABLE_DOC_PATTERN.test('Cédula de Técnico en Plomería y Gas'), false);
      assert.equal(
        NON_PUBLISHABLE_DOC_PATTERN.test('Acreditación de Cerrajero Residencial'),
        false,
      );
    });
  });

  describe('Controlador de Visibilidad de Documentos', () => {
    it('rechaza con 401 si el usuario no ha iniciado sesión', async () => {
      const req = {
        params: { id: '10' },
        body: { is_public: true },
      } as unknown as Request;
      const res = { status: () => res, json: () => res } as unknown as Response;
      let errorThrown: unknown = null;
      const next: NextFunction = (err?: unknown) => {
        errorThrown = err;
      };

      await supplierDocumentVisibilityController.updateVisibility(req, res, next);
      assert.ok(errorThrown instanceof UnauthorizedError);
      assert.equal((errorThrown as UnauthorizedError).statusCode, 401);
    });

    it('rechaza con 400 si is_public no es un booleano', async () => {
      const req = {
        params: { id: '10' },
        body: { is_public: 'true' }, // string en lugar de booleano
        user: fakeAdminUser,
      } as unknown as Request;
      const res = { status: () => res, json: () => res } as unknown as Response;
      let errorThrown: unknown = null;
      const next: NextFunction = (err?: unknown) => {
        errorThrown = err;
      };

      await supplierDocumentVisibilityController.updateVisibility(req, res, next);
      assert.ok(errorThrown instanceof BadRequestError);
      assert.equal((errorThrown as BadRequestError).statusCode, 400);
      assert.match(
        (errorThrown as BadRequestError).message,
        /is_public es obligatorio y debe ser un valor booleano/,
      );
    });
  });
});

describe('API-20: Portafolio de Trabajos (portfolioService)', () => {
  it('rechaza crear trabajo sin título o con título en blanco', async () => {
    await assert.rejects(
      async () => {
        await portfolioService.addWorkToPortfolio(
          '1',
          {
            title: '   ',
            description: 'Instalación de tubería',
            media: [{ file_key: 'photos/1/2026/11/trabajo1.jpg' }],
          },
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal((err as BadRequestError).message, 'El título del trabajo es obligatorio.');
        return true;
      },
    );
  });

  it('rechaza crear trabajo con lista de fotos vacía', async () => {
    await assert.rejects(
      async () => {
        await portfolioService.addWorkToPortfolio(
          '1',
          {
            title: 'Reparación de fuga',
            media: [],
          },
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'Debes incluir entre 1 y 10 fotos para el trabajo del portafolio.',
        );
        return true;
      },
    );
  });

  it('rechaza crear trabajo con más de 10 fotos', async () => {
    const elevenPhotos = Array.from({ length: 11 }, (_, i) => ({
      file_key: `photos/1/2026/11/foto_${i + 1}.jpg`,
      description: `Foto ${i + 1}`,
    }));

    await assert.rejects(
      async () => {
        await portfolioService.addWorkToPortfolio(
          '1',
          {
            title: 'Remodelación completa de baño',
            media: elevenPhotos,
          },
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'Debes incluir entre 1 y 10 fotos para el trabajo del portafolio.',
        );
        return true;
      },
    );
  });

  it('rechaza crear trabajo si una foto no tiene file_key válido', async () => {
    await assert.rejects(
      async () => {
        await portfolioService.addWorkToPortfolio(
          '1',
          {
            title: 'Instalación eléctrica',
            media: [{ file_key: 'photos/1/2026/11/ok.jpg' }, { file_key: '   ' }],
          },
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'Cada foto debe incluir un file_key válido.',
        );
        return true;
      },
    );
  });
});

describe('API-20: Categorías de Sucursal (portfolioService.updateBranchCategories)', () => {
  it('rechaza lista de categorías vacía', async () => {
    await assert.rejects(
      async () => {
        await portfolioService.updateBranchCategories('1', [], fakeAdminUser);
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'Debes especificar al menos una categoría con su precio base.',
        );
        return true;
      },
    );
  });

  it('rechaza categoría con base_price inválido o negativo', async () => {
    await assert.rejects(
      async () => {
        await portfolioService.updateBranchCategories(
          '1',
          [{ category_id: '5', base_price: '-50' }],
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'Cada categoría debe tener un category_id válido y un base_price numérico mayor o igual a 0.',
        );
        return true;
      },
    );
  });

  it('rechaza categoría con base_price no numérico', async () => {
    await assert.rejects(
      async () => {
        await portfolioService.updateBranchCategories(
          '1',
          [{ category_id: '5', base_price: 'gratis' }],
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        return true;
      },
    );
  });
});

describe('API-20: Perfil y Vehículo del Empleado (employeeProfileService)', () => {
  it('rechaza biografía de empleado que excede 1000 caracteres', async () => {
    const longBio = 'A'.repeat(1001);

    await assert.rejects(
      async () => {
        await employeeProfileService.updateEmployeeProfile('1', { bio: longBio }, fakeAdminUser);
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'La biografía no puede exceder los 1000 caracteres.',
        );
        return true;
      },
    );
  });

  it('rechaza registro de vehículo con campos obligatorios faltantes', async () => {
    await assert.rejects(
      async () => {
        await employeeProfileService.updateEmployeeVehicle(
          '1',
          {
            plate: 'ABC-1234',
            brand: 'Nissan',
            model: '', // vacío
            color: 'Blanco',
          },
          fakeAdminUser,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        assert.equal(
          (err as BadRequestError).message,
          'Los campos plate, brand, model y color son obligatorios.',
        );
        return true;
      },
    );
  });

  it('controlador getMyEmployeeProfile rechaza si no hay usuario autenticado', async () => {
    const req = {} as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;
    let errorThrown: unknown = null;
    const next: NextFunction = (err?: unknown) => {
      errorThrown = err;
    };

    await employeeProfileController.getMyEmployeeProfile(req, res, next);
    assert.ok(errorThrown instanceof UnauthorizedError);
    assert.equal((errorThrown as UnauthorizedError).statusCode, 401);
  });

  it('controlador updateEmployeeProfile rechaza si no hay usuario autenticado', async () => {
    const req = {
      params: { id: '5' },
      body: { bio: 'Técnico certificado' },
    } as unknown as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;
    let errorThrown: unknown = null;
    const next: NextFunction = (err?: unknown) => {
      errorThrown = err;
    };

    await employeeProfileController.updateEmployeeProfile(req, res, next);
    assert.ok(errorThrown instanceof UnauthorizedError);
  });

  it('controlador updateEmployeeVehicle rechaza si no hay usuario autenticado', async () => {
    const req = {
      params: { id: '5' },
      body: { plate: 'ABC-123', brand: 'Ford', model: 'Ranger', color: 'Rojo' },
    } as unknown as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;
    let errorThrown: unknown = null;
    const next: NextFunction = (err?: unknown) => {
      errorThrown = err;
    };

    await employeeProfileController.updateEmployeeVehicle(req, res, next);
    assert.ok(errorThrown instanceof UnauthorizedError);
  });

  it('controlador deleteEmployeeVehicle rechaza si no hay usuario autenticado', async () => {
    const req = {
      params: { id: '5' },
    } as unknown as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;
    let errorThrown: unknown = null;
    const next: NextFunction = (err?: unknown) => {
      errorThrown = err;
    };

    await employeeProfileController.deleteEmployeeVehicle(req, res, next);
    assert.ok(errorThrown instanceof UnauthorizedError);
  });

  after(async () => {
    await closeDatabase();
  });
});
