import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidServiceRequestTransition } from '../../utils/service-request-transitions.ts';

describe('máquina de estados de solicitudes (API-26)', () => {
    it('permite aceptar o agendar una solicitud pendiente', () => {
        assert.equal(isValidServiceRequestTransition('pendiente', 'aceptada'), true);
        assert.equal(isValidServiceRequestTransition('pendiente', 'agendada'), true);
    });

    it('permite cancelar o expirar una solicitud pendiente', () => {
        assert.equal(isValidServiceRequestTransition('pendiente', 'cancelada'), true);
        assert.equal(isValidServiceRequestTransition('pendiente', 'expirada'), true);
    });

    it('permite el avance secuencial del técnico', () => {
        assert.equal(isValidServiceRequestTransition('aceptada', 'en_camino'), true);
        assert.equal(isValidServiceRequestTransition('agendada', 'en_camino'), true);
        assert.equal(isValidServiceRequestTransition('en_camino', 'llegado'), true);
        assert.equal(isValidServiceRequestTransition('llegado', 'completada'), true);
    });

    it('permite cancelar antes de completar', () => {
        assert.equal(isValidServiceRequestTransition('aceptada', 'cancelada'), true);
        assert.equal(isValidServiceRequestTransition('agendada', 'cancelada'), true);
        assert.equal(isValidServiceRequestTransition('en_camino', 'cancelada'), true);
        assert.equal(isValidServiceRequestTransition('llegado', 'cancelada'), true);
    });

    it('rechaza saltos, retrocesos y cambios desde estados terminales', () => {
        assert.equal(isValidServiceRequestTransition('pendiente', 'en_camino'), false);
        assert.equal(isValidServiceRequestTransition('aceptada', 'completada'), false);
        assert.equal(isValidServiceRequestTransition('llegado', 'en_camino'), false);
        assert.equal(isValidServiceRequestTransition('completada', 'cancelada'), false);
        assert.equal(isValidServiceRequestTransition('cancelada', 'aceptada'), false);
        assert.equal(isValidServiceRequestTransition('expirada', 'aceptada'), false);
    });
});
