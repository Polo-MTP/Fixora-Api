import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase } from '../../config/database.ts';
import {
  ACTIVE_SERVICE_LOCK,
  ACTIVE_SERVICE_STATUSES,
  activeServiceLockError,
  displayName,
  partiesToShow,
} from '../active-service.rules.ts';
import { ConflictError } from '../../errors/app-error.ts';

const notFrozen = {
  technician_name: null,
  technician_photo_key: null,
  vehicle_plate: null,
  vehicle_brand: null,
  vehicle_model: null,
  vehicle_color: null,
  client_name: null,
};

const live = {
  technicianName: 'Nombre Nuevo',
  technicianPhotoKey: 'photos/9/nueva.jpg',
  vehicle: { plate: 'ZZZ-999', brand: 'Ford', model: 'Ranger', color: 'Rojo' },
  clientName: 'Cliente Nuevo',
};

describe('API-55: datos congelados durante un servicio', () => {
  it('con la copia guardada al aceptar, se muestra la copia y no el perfil actual', () => {
    const shown = partiesToShow(
      {
        technician_name: 'Luis Torres',
        technician_photo_key: 'photos/9/original.jpg',
        vehicle_plate: 'FRX-123',
        vehicle_brand: 'Nissan',
        vehicle_model: 'NP300',
        vehicle_color: 'Blanco',
        client_name: 'Ana Pérez',
      },
      live,
    );
    assert.equal(shown.technicianName, 'Luis Torres');
    assert.equal(shown.technicianPhotoKey, 'photos/9/original.jpg');
    assert.deepEqual(shown.vehicle, {
      plate: 'FRX-123',
      brand: 'Nissan',
      model: 'NP300',
      color: 'Blanco',
    });
    assert.equal(shown.clientName, 'Ana Pérez');
  });

  it('si al aceptar no tenía vehículo, no aparece el que registró después', () => {
    const shown = partiesToShow(
      { ...notFrozen, technician_name: 'Luis Torres', client_name: 'Ana Pérez' },
      live,
    );
    assert.equal(shown.vehicle, null);
    assert.equal(shown.technicianPhotoKey, null);
  });

  it('sin copia (solicitudes anteriores a API-55) se usan los datos actuales', () => {
    assert.deepEqual(partiesToShow(notFrozen, live), live);
  });

  it('el error dice qué no se puede cambiar y usa 409 ACTIVE_SERVICE_LOCK', () => {
    const own = activeServiceLockError('tu nombre');
    assert.ok(own instanceof ConflictError);
    assert.equal(own.statusCode, 409);
    assert.equal(own.code, ACTIVE_SERVICE_LOCK);
    assert.match(own.message, /^No puedes cambiar tu nombre mientras tienes un servicio en curso/);

    const manager = activeServiceLockError('el vehículo', false);
    assert.match(manager.message, /del técnico mientras tiene un servicio en curso/);
  });

  it('el servicio está activo desde que se acepta hasta que termina o se cancela', () => {
    for (const status of ['aceptada', 'agendada', 'en_curso', 'en_camino', 'llegado']) {
      assert.ok((ACTIVE_SERVICE_STATUSES as readonly string[]).includes(status), status);
    }
    for (const status of ['pendiente', 'completada', 'cancelada', 'expirada']) {
      assert.ok(!(ACTIVE_SERVICE_STATUSES as readonly string[]).includes(status), status);
    }
  });

  it('el nombre que ve la otra parte es nombre y apellido paterno', () => {
    assert.equal(displayName({ name: 'Ana', lastname_p: 'Pérez' }), 'Ana Pérez');
    assert.equal(displayName(undefined), '');
  });

  after(async () => {
    await closeDatabase();
  });
});
