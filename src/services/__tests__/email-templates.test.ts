import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  renderVerificationCodeEmail,
  sendVerificationCodeEmail,
  renderPasswordResetEmail,
  sendPasswordResetEmail,
  renderSupplierApplicationReceivedEmail,
  sendSupplierApplicationReceivedEmail,
  renderSupplierVerificationResultEmail,
  sendSupplierVerificationResultEmail,
  setCustomEmailSender,
  type EmailPayload,
} from '../email.service.ts';

describe('Plantillas y Servicio de Correos Electrónicos (API-17)', () => {
  let dispatchedEmails: EmailPayload[] = [];

  beforeEach(() => {
    dispatchedEmails = [];
    setCustomEmailSender(async (payload) => {
      dispatchedEmails.push(payload);
      return { id: 'mock-email-id-12345' };
    });
  });

  afterEach(() => {
    setCustomEmailSender(null);
  });

  describe('escapeHtml (Seguridad XSS en plantillas)', () => {
    it('debe escapar caracteres peligrosos como <, >, &, ", y \'', () => {
      const malicious = '<script>alert("XSS & \'hack\'")</script>';
      const escaped = escapeHtml(malicious);

      assert.equal(escaped.includes('<script>'), false);
      assert.equal(escaped.includes('&lt;script&gt;'), true);
      assert.equal(escaped.includes('&quot;'), true);
      assert.equal(escaped.includes('&#039;'), true);
      assert.equal(escaped.includes('&amp;'), true);
    });

    it('debe manejar cadenas vacías sin lanzar excepción', () => {
      assert.equal(escapeHtml(''), '');
      // @ts-expect-error probando valor nulo
      assert.equal(escapeHtml(null), '');
    });
  });

  describe('1. Verificación de correo (Sprint 1)', () => {
    it('debe maquetar el código de verificación con expiración correcta', () => {
      const rendered = renderVerificationCodeEmail('Juan Pérez', '592813', 15);

      assert.equal(rendered.subject, 'Verifica tu correo electrónico - Fixora');
      assert.ok(rendered.html.includes('Juan Pérez'));
      assert.ok(rendered.html.includes('592813'));
      assert.ok(rendered.html.includes('15 minutos'));
      assert.ok(rendered.text.includes('592813'));
      assert.ok(rendered.text.includes('15 minutos'));
    });

    it('debe enviar el correo de verificación vía emisor configurado', async () => {
      await sendVerificationCodeEmail('juan@example.com', 'Juan Pérez', '123456');

      assert.equal(dispatchedEmails.length, 1);
      assert.equal(dispatchedEmails[0].to, 'juan@example.com');
      assert.equal(dispatchedEmails[0].subject, 'Verifica tu correo electrónico - Fixora');
      assert.ok(dispatchedEmails[0].html.includes('123456'));
    });
  });

  describe('2. Recuperación de contraseña (API-17)', () => {
    it('debe maquetar el correo de recuperación con código de 6 dígitos', () => {
      const rendered = renderPasswordResetEmail({
        email: 'carlos@example.com',
        name: 'Carlos Mendoza',
        code: '748291',
        expiresInMinutes: 20,
      });

      assert.equal(rendered.subject, 'Restablece tu contraseña - Fixora');
      assert.ok(rendered.html.includes('Carlos Mendoza'));
      assert.ok(rendered.html.includes('748291'));
      assert.ok(rendered.html.includes('20 minutos'));
      assert.ok(rendered.text.includes('748291'));
      assert.ok(rendered.text.includes('20 minutos'));
    });

    it('debe maquetar el correo con enlace directo para restablecer contraseña', () => {
      const resetLink = 'https://fixora.app/auth/reset-password?token=secure-token-abc';
      const rendered = renderPasswordResetEmail({
        email: 'carlos@example.com',
        name: 'Carlos Mendoza',
        resetLink,
      });

      assert.ok(rendered.html.includes(resetLink));
      assert.ok(rendered.html.includes('Restablecer Contraseña'));
      assert.ok(rendered.text.includes(resetLink));
    });

    it('debe enviar el correo de recuperación a través del emisor', async () => {
      await sendPasswordResetEmail({
        email: 'recupera@fixora.com',
        name: 'Ana López',
        code: '901234',
        expiresInMinutes: 10,
      });

      assert.equal(dispatchedEmails.length, 1);
      assert.equal(dispatchedEmails[0].to, 'recupera@fixora.com');
      assert.equal(dispatchedEmails[0].subject, 'Restablece tu contraseña - Fixora');
      assert.ok(dispatchedEmails[0].html.includes('901234'));
      assert.ok(dispatchedEmails[0].html.includes('Ana López'));
    });
  });

  describe('3. Solicitud de proveedor recibida (API-17)', () => {
    it('debe maquetar el correo de confirmación de solicitud con folio y datos del negocio', () => {
      const rendered = renderSupplierApplicationReceivedEmail({
        email: 'negocio@reparaciones.com',
        managerName: 'Roberto Gómez',
        businessName: 'Servicios Integrales Gómez',
        applicationId: '405',
        supplierType: 'empresa',
      });

      assert.equal(
        rendered.subject,
        'Hemos recibido tu solicitud de proveedor - Fixora (Folio #405)',
      );
      assert.ok(rendered.html.includes('#405'));
      assert.ok(rendered.html.includes('Servicios Integrales Gómez'));
      assert.ok(rendered.html.includes('Roberto Gómez'));
      assert.ok(rendered.html.includes('Empresa con sucursales'));
      assert.ok(rendered.html.includes('24 y 48 horas hábiles'));

      assert.ok(rendered.text.includes('#405'));
      assert.ok(rendered.text.includes('Servicios Integrales Gómez'));
      assert.ok(rendered.text.includes('24 a 48 horas'));
    });

    it('debe enviar el correo de solicitud recibida mediante el emisor', async () => {
      await sendSupplierApplicationReceivedEmail({
        email: 'contacto@plomeria-express.com',
        managerName: 'Elena Ramos',
        businessName: 'Plomería Express',
        applicationId: '789',
        supplierType: 'independiente',
      });

      assert.equal(dispatchedEmails.length, 1);
      assert.equal(dispatchedEmails[0].to, 'contacto@plomeria-express.com');
      assert.ok(dispatchedEmails[0].subject.includes('#789'));
      assert.ok(dispatchedEmails[0].html.includes('Plomería Express'));
    });
  });

  describe('4. Resultado de la verificación (API-17)', () => {
    it('debe maquetar el resultado APROBADO con felicitación e instrucciones del portal', () => {
      const rendered = renderSupplierVerificationResultEmail({
        email: 'aprobado@fixora.com',
        managerName: 'Mario Bros',
        businessName: 'Fontanería Bros',
        status: 'aprobada',
        portalUrl: 'https://fixora.app/portal/dashboard',
      });

      assert.equal(
        rendered.subject,
        '¡Felicidades! Tu cuenta de proveedor ha sido aprobada - Fixora',
      );
      assert.ok(rendered.html.includes('Aprobada'));
      assert.ok(rendered.html.includes('Fontanería Bros'));
      assert.ok(rendered.html.includes('¡Tu cuenta está habilitada!'));
      assert.ok(rendered.html.includes('https://fixora.app/portal/dashboard'));
      assert.ok(rendered.text.includes('aprobadas con éxito'));
    });

    it('debe maquetar el resultado RECHAZADO con las observaciones y motivos', () => {
      const rendered = renderSupplierVerificationResultEmail({
        email: 'rechazado@fixora.com',
        managerName: 'Pedro Picapiedra',
        businessName: 'Canteras Picapiedra',
        status: 'rechazada',
        comments: 'La constancia de situación fiscal no coincide con el RFC registrado.',
      });

      assert.equal(rendered.subject, 'Actualización sobre tu solicitud de proveedor - Fixora');
      assert.ok(rendered.html.includes('Rechazada'));
      assert.ok(rendered.html.includes('Canteras Picapiedra'));
      assert.ok(
        rendered.html.includes(
          'La constancia de situación fiscal no coincide con el RFC registrado.',
        ),
      );
      assert.ok(
        rendered.text.includes(
          'La constancia de situación fiscal no coincide con el RFC registrado.',
        ),
      );
    });

    it('debe maquetar el resultado DOCUMENTACIÓN INCOMPLETA con lista de documentos faltantes', () => {
      const rendered = renderSupplierVerificationResultEmail({
        email: 'incompleto@fixora.com',
        managerName: 'Laura Torres',
        businessName: 'Electricidad Torres',
        status: 'documentacion_incompleta',
        comments: 'El comprobante de domicilio está vencido (antigüedad mayor a 3 meses).',
        missingDocuments: [
          'Comprobante de Domicilio Vigente',
          'Identificación Oficial con Fotografía (Reverso)',
        ],
        portalUrl: 'https://fixora.app/portal/solicitud/documentos',
      });

      assert.equal(
        rendered.subject,
        'Acción requerida: Documentación incompleta en tu solicitud - Fixora',
      );
      assert.ok(rendered.html.includes('Documentación Incompleta'));
      assert.ok(rendered.html.includes('Electricidad Torres'));
      assert.ok(rendered.html.includes('Comprobante de Domicilio Vigente'));
      assert.ok(rendered.html.includes('Identificación Oficial con Fotografía (Reverso)'));
      assert.ok(rendered.html.includes('https://fixora.app/portal/solicitud/documentos'));
      assert.ok(rendered.text.includes('Comprobante de Domicilio Vigente'));
    });

    it('debe despachar el correo de resultado de verificación mediante sendSupplierVerificationResultEmail', async () => {
      await sendSupplierVerificationResultEmail({
        email: 'notifica@fixora.com',
        managerName: 'Sonia Díaz',
        businessName: 'Climas Díaz',
        status: 'aprobado',
      });

      assert.equal(dispatchedEmails.length, 1);
      assert.equal(dispatchedEmails[0].to, 'notifica@fixora.com');
      assert.ok(dispatchedEmails[0].subject.includes('aprobada'));
      assert.ok(dispatchedEmails[0].html.includes('Climas Díaz'));
    });
  });

  describe('Control de errores en el emisor de correos', () => {
    it('debe lanzar un error cuando el emisor reporta una falla', async () => {
      setCustomEmailSender(async () => {
        return { error: 'Simulated network timeout' };
      });

      await assert.rejects(
        () => sendVerificationCodeEmail('fallo@fixora.com', 'Usuario', '111222'),
        (err: Error) => err.message.includes('Simulated network timeout'),
      );
    });
  });
});
