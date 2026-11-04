import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SupplierApplicationService } from '../supplier-application.service.ts';
import { BadRequestError } from '../../errors/app-error.ts';
import type { CreateSupplierApplicationInput } from '../../types/supplier-application.types.ts';

describe('Asistente web de registro de proveedores (SupplierApplicationService)', () => {
  const service = new SupplierApplicationService();

  const validApplicationInput: CreateSupplierApplicationInput = {
    manager: {
      email: 'encargado.test@fixora.com',
      password: 'Password123!',
      name: 'Carlos',
      lastname_p: 'Mendoza',
      lastname_m: 'López',
      birth_date: '1988-05-14',
      phone: '5512345678',
    },
    supplier_type: 'independiente',
    rfc: 'MELC8805141A1',
    business: {
      name: 'Reparaciones Mendoza',
      tax_identification: 'MELC8805141A1',
      email: 'contacto@mendoza.com',
      phone: '5512345678',
    },
    branches: [
      {
        name: 'Matriz Centro',
        phone: '5512345678',
        email: 'matriz@mendoza.com',
        description: 'Taller principal de servicios',
        address: {
          street: 'Av. Juárez',
          num_ext: '120',
          num_int: '2B',
          colony: 'Centro',
          municipality: 'Cuauhtémoc',
          state: 'Ciudad de México',
          postal_code: '06000',
          country: 'México',
          latitude: 19.4326,
          longitude: -99.1332,
          reference: 'Frente al parque',
        },
        schedules: [
          { day_of_week: 1, open_time: '08:00', close_time: '18:00' },
          { day_of_week: 2, open_time: '08:00', close_time: '18:00' },
          { day_of_week: 3, open_time: '08:00', close_time: '18:00' },
        ],
        categories: [
          { category_id: 1, base_price: 350.0, duration_minutes: 60 },
          { category_id: 2, base_price: 500.0, duration_minutes: 90 },
        ],
      },
    ],
  };

  describe('Validación de datos del Encargado', () => {
    it('debe rechazar si faltan los datos del encargado', async () => {
      const invalid = {
        ...validApplicationInput,
        manager: null as unknown as typeof validApplicationInput.manager,
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('encargado son obligatorios'),
      );
    });

    it('debe rechazar si el correo del encargado es inválido', async () => {
      const invalid = {
        ...validApplicationInput,
        manager: { ...validApplicationInput.manager, email: 'correo-invalido' },
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError &&
          err.message.includes('correo electrónico no tiene un formato válido'),
      );
    });

    it('debe rechazar si la contraseña tiene menos de 8 caracteres', async () => {
      const invalid = {
        ...validApplicationInput,
        manager: { ...validApplicationInput.manager, password: '123' },
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('al menos 8 caracteres'),
      );
    });

    it('debe rechazar si falta el nombre o apellido del encargado', async () => {
      const invalid = {
        ...validApplicationInput,
        manager: { ...validApplicationInput.manager, name: '' },
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('nombre y apellido paterno'),
      );
    });
  });

  describe('Validación de Negocio y Tipo de Proveedor', () => {
    it('debe rechazar si el supplier_type no es independiente ni empresa', async () => {
      const invalid = {
        ...validApplicationInput,
        supplier_type: 'corporativo' as unknown as 'empresa',
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes("'independiente' o 'empresa'"),
      );
    });

    it('debe rechazar si falta el nombre del negocio', async () => {
      const invalid = {
        ...validApplicationInput,
        business: { ...validApplicationInput.business, name: '   ' },
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError &&
          err.message.includes('nombre del negocio es obligatorio'),
      );
    });

    it('debe rechazar si un independiente registra más de una sucursal', async () => {
      const invalid = {
        ...validApplicationInput,
        supplier_type: 'independiente' as const,
        branches: [
          validApplicationInput.branches[0],
          { ...validApplicationInput.branches[0], name: 'Segunda Sucursal' },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError &&
          err.message.includes('solo puede registrar una sucursal'),
      );
    });
  });

  describe('Validación de Locales (Dirección, Horarios y Categorías)', () => {
    it('debe rechazar si el arreglo de sucursales está vacío', async () => {
      const invalid = { ...validApplicationInput, branches: [] };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('al menos una sucursal'),
      );
    });

    it('debe rechazar si falta la calle o el código postal en la dirección', async () => {
      const invalid = {
        ...validApplicationInput,
        branches: [
          {
            ...validApplicationInput.branches[0],
            address: { ...validApplicationInput.branches[0].address, street: '' },
          },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('dirección completa'),
      );
    });

    it('debe rechazar si una sucursal no incluye horarios de atención', async () => {
      const invalid = {
        ...validApplicationInput,
        branches: [
          {
            ...validApplicationInput.branches[0],
            schedules: [],
          },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('al menos un horario'),
      );
    });

    it('debe rechazar si el día de la semana no es un número entre 0 y 6', async () => {
      const invalid = {
        ...validApplicationInput,
        branches: [
          {
            ...validApplicationInput.branches[0],
            schedules: [{ day_of_week: 7, open_time: '09:00', close_time: '18:00' }],
          },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('de 0 (domingo) a 6 (sábado)'),
      );
    });

    it('debe rechazar si el formato de horario no es HH:MM', async () => {
      const invalid = {
        ...validApplicationInput,
        branches: [
          {
            ...validApplicationInput.branches[0],
            schedules: [{ day_of_week: 1, open_time: '25:00', close_time: '18:00' }],
          },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) => err instanceof BadRequestError && err.message.includes('formato HH:MM'),
      );
    });

    it('debe rechazar si una sucursal no tiene categorías asignadas', async () => {
      const invalid = {
        ...validApplicationInput,
        branches: [
          {
            ...validApplicationInput.branches[0],
            categories: [],
          },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('al menos una categoría'),
      );
    });

    it('debe rechazar si el precio base de la categoría no es positivo', async () => {
      const invalid = {
        ...validApplicationInput,
        branches: [
          {
            ...validApplicationInput.branches[0],
            categories: [{ category_id: 1, base_price: 0, duration_minutes: 60 }],
          },
        ],
      };
      await assert.rejects(
        async () => service.createApplication(invalid),
        (err: Error) =>
          err instanceof BadRequestError && err.message.includes('debe ser un valor positivo'),
      );
    });
  });

  describe('Consulta de estado de solicitud', () => {
    it('debe rechazar si no se envía ni applicationId ni email', async () => {
      await assert.rejects(
        async () => service.getApplicationStatus({}),
        (err: Error) =>
          err instanceof BadRequestError &&
          err.message.includes('el id de la solicitud o el correo'),
      );
    });
  });
});
