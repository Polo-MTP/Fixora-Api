import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import { closeDatabase } from '../../config/database.ts';
import {
  checkBranchSchedule,
  technicianAvailabilityService,
  TECHNICIAN_ONLINE_TTL_SECONDS,
} from '../technician-availability.service.ts';
import { technicianAvailabilityController } from '../../controllers/technician-availability.controller.ts';
import { AppError, BadRequestError, UnauthorizedError } from '../../errors/app-error.ts';
import type { AuthenticatedUser } from '../../middlewares/auth.middleware.ts';

const fakeTechUser: AuthenticatedUser = {
  id: '25',
  role: 'empleado',
  sessionId: 'test-session-tech-25',
};

describe('API-22: Disponibilidad y Posición de Técnicos en Redis', () => {
  describe('Evaluación de Horario de Sucursal (checkBranchSchedule)', () => {
    const defaultBranch = {
      accepting_request: true,
      timezone: 'America/Mexico_City',
    };

    // Horario: Lunes (1) de 09:00 a 18:00
    const schedules = [
      {
        day_of_week: 1, // Lunes
        open_time: '09:00:00',
        close_time: '18:00:00',
        active: true,
      },
      {
        day_of_week: 2, // Martes
        open_time: '10:00:00',
        close_time: '14:00:00',
        active: true,
      },
    ];

    it('bloquea si accepting_request es false', () => {
      const result = checkBranchSchedule({ ...defaultBranch, accepting_request: false }, schedules);
      assert.equal(result.isOpen, false);
      assert.equal(result.reason, 'NOT_ACCEPTING_REQUESTS');
      assert.match(result.message || '', /deshabilitada la recepción de solicitudes/);
    });

    it('bloquea si la sucursal no tiene horario activo para el día de la semana', () => {
      // Domingo 15 de Noviembre de 2026 (day_of_week = 0)
      const sundayDate = new Date('2026-11-15T12:00:00-06:00');
      const result = checkBranchSchedule(defaultBranch, schedules, sundayDate);

      assert.equal(result.isOpen, false);
      assert.equal(result.reason, 'NO_SCHEDULE_TODAY');
      assert.equal(result.currentDayOfWeek, 0);
    });

    it('bloquea si la hora actual es antes de la hora de apertura', () => {
      // Lunes 16 de Noviembre de 2026 a las 08:30 (abre a las 09:00)
      const earlyDate = new Date('2026-11-16T08:30:00-06:00');
      const result = checkBranchSchedule(defaultBranch, schedules, earlyDate);

      assert.equal(result.isOpen, false);
      assert.equal(result.reason, 'OUTSIDE_HOURS');
      assert.match(result.message || '', /Fuera del horario de atención/);
    });

    it('bloquea si la hora actual es después de la hora de cierre', () => {
      // Lunes 16 de Noviembre de 2026 a las 18:30 (cierra a las 18:00)
      const lateDate = new Date('2026-11-16T18:30:00-06:00');
      const result = checkBranchSchedule(defaultBranch, schedules, lateDate);

      assert.equal(result.isOpen, false);
      assert.equal(result.reason, 'OUTSIDE_HOURS');
    });

    it('permite ponerse en línea dentro del horario de atención', () => {
      // Lunes 16 de Noviembre de 2026 a las 14:00 (entre 09:00 y 18:00)
      const validDate = new Date('2026-11-16T14:00:00-06:00');
      const result = checkBranchSchedule(defaultBranch, schedules, validDate);

      assert.equal(result.isOpen, true);
      assert.equal(result.currentDayOfWeek, 1);
      assert.equal(result.currentTime, '14:00');
    });
  });

  describe('Validaciones de Entrada (technicianAvailabilityService)', () => {
    it('constante TECHNICIAN_ONLINE_TTL_SECONDS es de 300 segundos (5 minutos)', () => {
      assert.equal(TECHNICIAN_ONLINE_TTL_SECONDS, 300);
    });

    it('rechaza ponerse en línea sin coordenadas geográficas válidas', async () => {
      await assert.rejects(
        async () => {
          await technicianAvailabilityService.updateTechnicianAvailability('1', {
            online: true,
            // Sin latitude ni longitude
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match((err as BadRequestError).message, /debes enviar tu ubicación actual válida/);
          return true;
        },
      );
    });

    it('rechaza latitud fuera de rango (-90 a 90)', async () => {
      await assert.rejects(
        async () => {
          await technicianAvailabilityService.updateTechnicianAvailability('1', {
            online: true,
            latitude: 105.5,
            longitude: -99.13,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match((err as BadRequestError).message, /latitud debe estar entre -90 y 90/);
          return true;
        },
      );
    });

    it('rechaza longitud fuera de rango (-180 a 180)', async () => {
      await assert.rejects(
        async () => {
          await technicianAvailabilityService.updateTechnicianAvailability('1', {
            online: true,
            latitude: 19.43,
            longitude: -200,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match((err as BadRequestError).message, /longitud debe estar entre -180 y 180/);
          return true;
        },
      );
    });
  });

  describe('Controlador HTTP de Disponibilidad (technicianAvailabilityController)', () => {
    it('rechaza consultar disponibilidad sin sesión (401 UnauthorizedError)', async () => {
      const req = {} as Request;
      const res = { status: () => res, json: () => res } as unknown as Response;
      let errorThrown: unknown = null;
      const next: NextFunction = (err?: unknown) => {
        errorThrown = err;
      };

      await technicianAvailabilityController.getMyAvailability(req, res, next);
      assert.ok(errorThrown instanceof UnauthorizedError);
      assert.equal((errorThrown as UnauthorizedError).statusCode, 401);
    });

    it('rechaza actualizar disponibilidad sin sesión (401 UnauthorizedError)', async () => {
      const req = {
        body: { online: true, latitude: 19.43, longitude: -99.13 },
      } as unknown as Request;
      const res = { status: () => res, json: () => res } as unknown as Response;
      let errorThrown: unknown = null;
      const next: NextFunction = (err?: unknown) => {
        errorThrown = err;
      };

      await technicianAvailabilityController.updateMyAvailability(req, res, next);
      assert.ok(errorThrown instanceof UnauthorizedError);
    });

    it('rechaza si online no es booleano (400 BadRequestError)', async () => {
      const req = {
        user: fakeTechUser,
        body: { online: 'si' }, // string no booleano
      } as unknown as Request;
      const res = { status: () => res, json: () => res } as unknown as Response;
      let errorThrown: unknown = null;
      const next: NextFunction = (err?: unknown) => {
        errorThrown = err;
      };

      await technicianAvailabilityController.updateMyAvailability(req, res, next);
      assert.ok(errorThrown instanceof BadRequestError);
      assert.match(
        (errorThrown as BadRequestError).message,
        /campo online es obligatorio y debe ser un valor booleano/,
      );
    });

    it('permite cambiar a fuera de línea exitosamente llamando al servicio', async () => {
      const originalMethod = technicianAvailabilityService.updateMyAvailability;
      technicianAvailabilityService.updateMyAvailability = async () => ({
        employee_id: '25',
        user_id: '25',
        branch_id: '3',
        online: false,
        location: null,
        branch: {
          id: '3',
          accepting_request: true,
          is_open: true,
        },
        expires_in_seconds: 0,
        updated_at: new Date().toISOString(),
      });

      try {
        let statusCode: number | null = null;
        let responseBody: unknown = null;

        const req = {
          user: fakeTechUser,
          body: { online: false },
        } as unknown as Request;

        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (body: unknown) => {
            responseBody = body;
            return res;
          },
        } as unknown as Response;

        const next: NextFunction = () => {};

        await technicianAvailabilityController.updateMyAvailability(req, res, next);

        assert.equal(statusCode, 200);
        const typedBody = responseBody as {
          success: boolean;
          message: string;
          data: { online: boolean };
        };
        assert.equal(typedBody.success, true);
        assert.equal(typedBody.data.online, false);
        assert.match(typedBody.message, /Fuera de línea/);
      } finally {
        technicianAvailabilityService.updateMyAvailability = originalMethod;
      }
    });

    it('propaga error 409 cuando la sucursal está fuera de horario', async () => {
      const originalMethod = technicianAvailabilityService.updateMyAvailability;
      technicianAvailabilityService.updateMyAvailability = async () => {
        throw new AppError(
          'No puedes ponerte en línea fuera del horario de atención de la sucursal.',
          409,
          'OUTSIDE_BRANCH_SCHEDULE',
        );
      };

      try {
        const req = {
          user: fakeTechUser,
          body: { online: true, latitude: 19.43, longitude: -99.13 },
        } as unknown as Request;

        const res = { status: () => res, json: () => res } as unknown as Response;
        let errorCaught: unknown = null;
        const next: NextFunction = (err?: unknown) => {
          errorCaught = err;
        };

        await technicianAvailabilityController.updateMyAvailability(req, res, next);

        assert.ok(errorCaught instanceof AppError);
        assert.equal((errorCaught as AppError).statusCode, 409);
        assert.equal((errorCaught as AppError).code, 'OUTSIDE_BRANCH_SCHEDULE');
      } finally {
        technicianAvailabilityService.updateMyAvailability = originalMethod;
      }
    });
  });

  after(async () => {
    await closeDatabase();
  });
});
