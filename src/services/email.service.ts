import { Resend } from 'resend';
import { ENV } from '../config/env.ts';
import type {
  EmailPayload,
  EmailSender,
  PasswordResetEmailOptions,
  RenderedEmail,
  SupplierApplicationReceivedEmailOptions,
  SupplierVerificationResultEmailOptions,
} from '../types/email.types.ts';

export * from '../types/email.types.ts';

/**
 * Escapa caracteres especiales para evitar inyecciones HTML en correos.
 */
export function escapeHtml(value: string): string {
  if (!value) return '';
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

let customEmailSender: EmailSender | null = null;

/**
 * Permite registrar un emisor simulado para pruebas unitarias sin conexión de red.
 */
export function setCustomEmailSender(sender: EmailSender | null): void {
  customEmailSender = sender;
}

/**
 * Obtiene el emisor de correos personalizado actual, si existe.
 */
export function getCustomEmailSender(): EmailSender | null {
  return customEmailSender;
}

/**
 * Envía un correo electrónico utilizando Resend o el emisor simulado si está configurado.
 */
async function dispatchEmail(payload: EmailPayload): Promise<void> {
  if (customEmailSender) {
    const res = await customEmailSender(payload);
    if (res?.error) {
      throw new Error(`Error en el emisor de correo: ${String(res.error)}`);
    }
    return;
  }

  if (!ENV.RESEND_API_KEY || !ENV.RESEND_FROM_EMAIL) {
    throw new Error('La configuración de Resend está incompleta.');
  }

  const resend = new Resend(ENV.RESEND_API_KEY);
  const from = payload.from || ENV.RESEND_FROM_EMAIL;

  const { error } = await resend.emails.send({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });

  if (error) {
    console.error('[email.service] Error de Resend:', error);
    throw new Error(`No fue posible enviar el correo a ${payload.to}.`);
  }
}

/**
 * Maquetación base común para los correos electrónicos con identidad visual Fixora.
 */
function wrapInBaseLayout(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="
    margin: 0;
    padding: 30px 15px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background-color: #f4f4f5;
    color: #18181b;
  ">
    <div style="
      max-width: 560px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #e4e4e7;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
    ">
      <!-- Encabezado con identidad Fixora -->
      <div style="
        padding: 28px 32px;
        background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%);
        text-align: center;
      ">
        <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 700; letter-spacing: 1px;">
          Fixora
        </h1>
        <p style="margin: 4px 0 0; color: #bfdbfe; font-size: 13px;">
          Red de servicios y soluciones para el hogar y negocio
        </p>
      </div>

      <!-- Cuerpo del mensaje -->
      <div style="padding: 32px;">
        ${bodyContent}
      </div>

      <!-- Pie de página informativo -->
      <div style="
        padding: 20px 32px;
        background-color: #fafafa;
        border-top: 1px solid #f4f4f5;
        text-align: center;
        color: #71717a;
        font-size: 12px;
        line-height: 1.5;
      ">
        <p style="margin: 0;">Fixora &copy; 2026. Todos los derechos reservados.</p>
        <p style="margin: 4px 0 0;">Este es un mensaje automático, por favor no respondas a este correo.</p>
      </div>
    </div>
  </body>
</html>`;
}

// ============================================================================
// 1. CÓDIGO DE VERIFICACIÓN (Sprint 1)
// ============================================================================

export function renderVerificationCodeEmail(
  name: string,
  code: string,
  expiresInMinutes: number = ENV.EMAIL_VERIFICATION_CODE_TTL_MINUTES || 10,
): RenderedEmail {
  const safeName = escapeHtml(name);
  const safeCode = escapeHtml(code);
  const subject = 'Verifica tu correo electrónico - Fixora';

  const text = `
Hola ${name},

Gracias por registrarte en Fixora.
Para verificar tu dirección de correo electrónico, introduce el siguiente código:

Código: ${code}

Este código vence en ${expiresInMinutes} minutos.

Si no solicitaste esta cuenta, puedes ignorar este correo de forma segura.
`.trim();

  const bodyHtml = `
    <h2 style="margin: 0 0 16px; color: #0f172a; font-size: 20px;">
      Verifica tu correo electrónico
    </h2>

    <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #334155;">
      Hola <strong>${safeName}</strong>,
    </p>

    <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #475569;">
      Gracias por registrarte en Fixora. Para verificar tu dirección de correo electrónico, introduce el siguiente código en la aplicación:
    </p>

    <div style="
      margin: 24px 0;
      padding: 20px;
      text-align: center;
      background-color: #eff6ff;
      border: 1px dashed #3b82f6;
      border-radius: 8px;
    ">
      <span style="
        font-size: 32px;
        font-weight: 700;
        letter-spacing: 8px;
        color: #1d4ed8;
      ">
        ${safeCode}
      </span>
    </div>

    <p style="margin: 0 0 16px; font-size: 13px; color: #64748b;">
      El código vence en <strong>${expiresInMinutes} minutos</strong>.
    </p>

    <p style="margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #f1f5f9; color: #94a3b8; font-size: 12px; line-height: 1.4;">
      Si no solicitaste esta cuenta, puedes ignorar este correo de forma segura.
    </p>
  `;

  return {
    subject,
    text,
    html: wrapInBaseLayout('Verificación de correo', bodyHtml),
  };
}

export async function sendVerificationCodeEmail(
  email: string,
  name: string,
  code: string,
): Promise<void> {
  const rendered = renderVerificationCodeEmail(name, code);
  await dispatchEmail({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

// ============================================================================
// 2. RECUPERACIÓN DE CONTRASEÑA (API-9 / API-17)
// ============================================================================

export function renderPasswordResetEmail(options: PasswordResetEmailOptions): RenderedEmail {
  const safeName = escapeHtml(options.name);
  const safeCode = options.code ? escapeHtml(options.code) : '';
  const safeLink = options.resetLink ? escapeHtml(options.resetLink) : '';
  const expiresInMinutes = options.expiresInMinutes ?? 15;
  const subject = 'Restablece tu contraseña - Fixora';

  let codeTextSection = '';
  if (options.code) {
    codeTextSection = `\nTu código de recuperación es: ${options.code}\n`;
  }
  let linkTextSection = '';
  if (options.resetLink) {
    linkTextSection = `\nTambién puedes acceder directamente al siguiente enlace:\n${options.resetLink}\n`;
  }

  const text = `
Hola ${options.name},

Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en Fixora.
${codeTextSection}${linkTextSection}
Este código o enlace vence en ${expiresInMinutes} minutos.

Si tú no realizaste esta solicitud, puedes ignorar este mensaje con tranquilidad. Tu contraseña actual no cambiará y tu cuenta permanece segura.
`.trim();

  let codeHtmlBlock = '';
  if (safeCode) {
    codeHtmlBlock = `
      <div style="
        margin: 24px 0;
        padding: 18px;
        text-align: center;
        background-color: #eff6ff;
        border: 1px dashed #3b82f6;
        border-radius: 8px;
      ">
        <p style="margin: 0 0 8px; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 600; letter-spacing: 0.5px;">
          Código de recuperación
        </p>
        <span style="
          font-size: 32px;
          font-weight: 700;
          letter-spacing: 8px;
          color: #1d4ed8;
        ">
          ${safeCode}
        </span>
      </div>
    `;
  }

  let linkHtmlBlock = '';
  if (safeLink) {
    linkHtmlBlock = `
      <div style="margin: 28px 0; text-align: center;">
        <a href="${safeLink}" style="
          display: inline-block;
          padding: 12px 28px;
          background-color: #2563eb;
          color: #ffffff;
          text-decoration: none;
          font-size: 14px;
          font-weight: 600;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);
        ">
          Restablecer Contraseña
        </a>
      </div>
      <p style="margin: 0 0 16px; font-size: 12px; color: #94a3b8; word-break: break-all;">
        O copia y pega este enlace en tu navegador: <br>
        <a href="${safeLink}" style="color: #2563eb;">${safeLink}</a>
      </p>
    `;
  }

  const bodyHtml = `
    <h2 style="margin: 0 0 16px; color: #0f172a; font-size: 20px;">
      Recuperación de contraseña
    </h2>

    <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #334155;">
      Hola <strong>${safeName}</strong>,
    </p>

    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
      Hemos recibido una solicitud para restablecer la contraseña de acceso a tu cuenta en Fixora.
    </p>

    ${codeHtmlBlock}
    ${linkHtmlBlock}

    <p style="margin: 0 0 16px; font-size: 13px; color: #64748b;">
      Esta solicitud tiene una vigencia de <strong>${expiresInMinutes} minutos</strong>.
    </p>

    <p style="margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #f1f5f9; color: #94a3b8; font-size: 12px; line-height: 1.4;">
      Si no solicitaste este cambio, puedes ignorar este correo de forma segura. Tu contraseña actual permanecerá intacta.
    </p>
  `;

  return {
    subject,
    text,
    html: wrapInBaseLayout('Recuperación de contraseña', bodyHtml),
  };
}

export async function sendPasswordResetEmail(options: PasswordResetEmailOptions): Promise<void> {
  const rendered = renderPasswordResetEmail(options);
  await dispatchEmail({
    to: options.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

/**
 * Función helper de compatibilidad para código que requiere la firma antigua `sendPasswordRecoveryCodeEmail`.
 */
export async function sendPasswordRecoveryCodeEmail(
  email: string,
  code: string,
  expiresInMinutes: number,
): Promise<void> {
  await sendPasswordResetEmail({
    email,
    name: 'Usuario',
    code,
    expiresInMinutes,
  });
}

// ============================================================================
// 3. SOLICITUD DE PROVEEDOR RECIBIDA (API-17)
// ============================================================================

export function renderSupplierApplicationReceivedEmail(
  options: SupplierApplicationReceivedEmailOptions,
): RenderedEmail {
  const safeName = escapeHtml(options.managerName);
  const safeBusiness = escapeHtml(options.businessName);
  const safeFolio = escapeHtml(options.applicationId);
  const safeType = options.supplierType
    ? escapeHtml(
      options.supplierType === 'empresa' ? 'Empresa con sucursales' : 'Profesional independiente',
    )
    : 'No especificado';
  const subject = `Hemos recibido tu solicitud de proveedor - Fixora (Folio #${options.applicationId})`;

  const text = `
Hola ${options.managerName},

Gracias por iniciar tu registro como proveedor en Fixora. Hemos recibido con éxito la documentación y los datos de tu solicitud.

Resumen de la Solicitud:
- Folio: #${options.applicationId}
- Negocio: ${options.businessName}
- Modalidad: ${safeType}
- Estado actual: Pendiente de revisión

Próximos pasos:
1. Nuestro equipo de auditoría validará tu información fiscal y los documentos adjuntos.
2. El tiempo estimado de respuesta es de 24 a 48 horas hábiles.
3. Te notificaremos a esta misma dirección de correo con el resultado de la verificación.

Puedes dar seguimiento a tu solicitud con el folio #${options.applicationId}.
`.trim();

  const bodyHtml = `
    <h2 style="margin: 0 0 16px; color: #0f172a; font-size: 20px;">
      ¡Hemos recibido tu solicitud de proveedor!
    </h2>

    <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #334155;">
      Hola <strong>${safeName}</strong>,
    </p>

    <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #475569;">
      Gracias por tu interés en formar parte de la red de profesionales de Fixora. Te confirmamos que hemos recibido satisfactoriamente la solicitud de registro para tu negocio <strong>${safeBusiness}</strong>.
    </p>

    <!-- Ficha informativa de la solicitud -->
    <table style="
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      background-color: #f8fafc;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #e2e8f0;
    ">
      <tr>
        <td style="padding: 10px 16px; color: #64748b; font-size: 13px; border-bottom: 1px solid #e2e8f0;">
          Folio de Solicitud:
        </td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b; font-size: 14px; border-bottom: 1px solid #e2e8f0;">
          #${safeFolio}
        </td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; color: #64748b; font-size: 13px; border-bottom: 1px solid #e2e8f0;">
          Negocio:
        </td>
        <td style="padding: 10px 16px; font-weight: 600; color: #1e293b; font-size: 13px; border-bottom: 1px solid #e2e8f0;">
          ${safeBusiness}
        </td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; color: #64748b; font-size: 13px; border-bottom: 1px solid #e2e8f0;">
          Tipo:
        </td>
        <td style="padding: 10px 16px; color: #1e293b; font-size: 13px; border-bottom: 1px solid #e2e8f0;">
          ${safeType}
        </td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; color: #64748b; font-size: 13px;">
          Estado:
        </td>
        <td style="padding: 10px 16px;">
          <span style="
            display: inline-block;
            padding: 3px 10px;
            background-color: #fef3c7;
            color: #92400e;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
          ">
            En revisión
          </span>
        </td>
      </tr>
    </table>

    <!-- Bloque de próximos pasos -->
    <h3 style="margin: 24px 0 10px; color: #0f172a; font-size: 15px;">
      ¿Qué sucederá ahora?
    </h3>

    <ol style="margin: 0 0 20px; padding-left: 20px; color: #475569; font-size: 13px; line-height: 1.6;">
      <li>Nuestro equipo administrativo revisará los documentos adjuntos (identificación, constancia fiscal y comprobantes).</li>
      <li>El periodo de validación suele tomar entre <strong>24 y 48 horas hábiles</strong>.</li>
      <li>Recibirás un nuevo correo electrónico en cuanto tu solicitud sea dictaminada.</li>
    </ol>

    <p style="margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #f1f5f9; color: #94a3b8; font-size: 12px; line-height: 1.4;">
      Conserva tu folio <strong>#${safeFolio}</strong> para cualquier consulta o aclaración con nuestro equipo de soporte.
    </p>
  `;

  return {
    subject,
    text,
    html: wrapInBaseLayout('Solicitud de proveedor recibida', bodyHtml),
  };
}

export async function sendSupplierApplicationReceivedEmail(
  options: SupplierApplicationReceivedEmailOptions,
): Promise<void> {
  const rendered = renderSupplierApplicationReceivedEmail(options);
  await dispatchEmail({
    to: options.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

// ============================================================================
// 4. RESULTADO DE LA VERIFICACIÓN (API-17)
// ============================================================================

export function renderSupplierVerificationResultEmail(
  options: SupplierVerificationResultEmailOptions,
): RenderedEmail {
  const safeName = escapeHtml(options.managerName);
  const safeBusiness = options.businessName ? escapeHtml(options.businessName) : 'tu negocio';
  const safeComments = options.comments ? escapeHtml(options.comments) : '';
  const portalUrl = options.portalUrl || `${ENV.APP_URL}/portal/proveedores`;
  const safePortalUrl = escapeHtml(portalUrl);

  const statusNormalized = options.status.toLowerCase();
  const isApproved = statusNormalized === 'aprobada' || statusNormalized === 'aprobado';
  const isRejected = statusNormalized === 'rechazada' || statusNormalized === 'rechazado';
  const isIncomplete = statusNormalized === 'documentacion_incompleta';

  let subject = 'Resultado de la verificación de proveedor - Fixora';
  let badgeColorBg = '#f4f4f5';
  let badgeColorFg = '#3f3f46';
  let badgeText = 'Actualización';
  let bodyDetailsHtml = '';
  let plainTextBody = '';

  if (isApproved) {
    subject = '¡Felicidades! Tu cuenta de proveedor ha sido aprobada - Fixora';
    badgeColorBg = '#dcfce7';
    badgeColorFg = '#166534';
    badgeText = 'Aprobada';

    plainTextBody = `
Hola ${options.managerName},

¡Excelentes noticias! La documentación y solicitud de tu negocio (${options.businessName || 'tu negocio'}) han sido verificadas y aprobadas con éxito.

Tu cuenta y tus sucursales ya se encuentran activas en el catálogo de Fixora, listas para comenzar a recibir solicitudes de servicios de nuevos clientes.

Ingresa a tu portal de proveedor para configurar tus servicios y disponibilidad:
${portalUrl}
`.trim();

    bodyDetailsHtml = `
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #334155;">
        Hola <strong>${safeName}</strong>,
      </p>

      <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
        ¡Excelentes noticias! La documentación y solicitud para <strong>${safeBusiness}</strong> han sido revisadas y <strong>aprobadas exitosamente</strong> por nuestro equipo de validación.
      </p>

      <div style="
        margin: 20px 0;
        padding: 16px;
        background-color: #f0fdf4;
        border-left: 4px solid #22c55e;
        border-radius: 4px;
        color: #15803d;
        font-size: 13px;
        line-height: 1.5;
      ">
        <strong>¡Tu cuenta está habilitada!</strong> Tus locales y servicios ya son visibles para los usuarios de la plataforma Fixora.
      </div>

      <div style="margin: 28px 0; text-align: center;">
        <a href="${safePortalUrl}" style="
          display: inline-block;
          padding: 12px 28px;
          background-color: #16a34a;
          color: #ffffff;
          text-decoration: none;
          font-size: 14px;
          font-weight: 600;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(22, 163, 74, 0.2);
        ">
          Ir al Portal de Proveedores
        </a>
      </div>
    `;
  } else if (isRejected) {
    subject = 'Actualización sobre tu solicitud de proveedor - Fixora';
    badgeColorBg = '#fee2e2';
    badgeColorFg = '#991b1b';
    badgeText = 'Rechazada';

    plainTextBody = `
Hola ${options.managerName},

Te informamos que, tras evaluar la documentación y datos enviados para ${options.businessName || 'tu negocio'}, lamentablemente no ha sido posible aprobar tu registro como proveedor en Fixora en esta ocasión.
${options.comments ? `\nMotivos u observaciones del revisor:\n${options.comments}\n` : ''}
Si requieres más información o deseas aclarar algún punto con nuestro equipo, por favor contacta a soporte.
`.trim();

    let commentsHtml = '';
    if (safeComments) {
      commentsHtml = `
        <div style="
          margin: 20px 0;
          padding: 16px;
          background-color: #fef2f2;
          border-left: 4px solid #ef4444;
          border-radius: 4px;
          color: #991b1b;
          font-size: 13px;
          line-height: 1.5;
        ">
          <strong style="display: block; margin-bottom: 4px;">Motivos u observaciones:</strong>
          ${safeComments}
        </div>
      `;
    }

    bodyDetailsHtml = `
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #334155;">
        Hola <strong>${safeName}</strong>,
      </p>

      <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
        Lamentamos informarte que, tras la revisión exhaustiva de la documentación presentada para <strong>${safeBusiness}</strong>, tu solicitud de registro no ha sido aprobada en esta oportunidad.
      </p>

      ${commentsHtml}

      <p style="margin: 16px 0; font-size: 13px; color: #64748b; line-height: 1.5;">
        Si consideras que existe algún error o deseas aclarar algún documento, no dudes en ponerte en contacto con nuestro equipo de atención a proveedores.
      </p>
    `;
  } else if (isIncomplete) {
    subject = 'Acción requerida: Documentación incompleta en tu solicitud - Fixora';
    badgeColorBg = '#fef3c7';
    badgeColorFg = '#92400e';
    badgeText = 'Documentación Incompleta';

    let missingListText = '';
    if (Array.isArray(options.missingDocuments) && options.missingDocuments.length > 0) {
      missingListText = `\nDocumentos por corregir o reemplazar:\n${options.missingDocuments.map((d) => `- ${d}`).join('\n')}\n`;
    }

    plainTextBody = `
Hola ${options.managerName},

Hemos revisado tu solicitud de proveedor para ${options.businessName || 'tu negocio'}. Para continuar con el proceso de aprobación, es necesario que actualices o sustituyas ciertos documentos requeridos.
${missingListText}${options.comments ? `\nObservaciones del auditor:\n${options.comments}\n` : ''}
Puedes reingresar al portal para reemplazar los documentos señalados:
${portalUrl}
`.trim();

    let missingListHtml = '';
    if (Array.isArray(options.missingDocuments) && options.missingDocuments.length > 0) {
      missingListHtml = `
        <h4 style="margin: 16px 0 8px; color: #1e293b; font-size: 14px;">
          Documentos requeridos para sustitución:
        </h4>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #334155; font-size: 13px; line-height: 1.6;">
          ${options.missingDocuments.map((doc) => `<li>${escapeHtml(doc)}</li>`).join('')}
        </ul>
      `;
    }

    let commentsHtml = '';
    if (safeComments) {
      commentsHtml = `
        <div style="
          margin: 16px 0;
          padding: 14px;
          background-color: #fffbeb;
          border-left: 4px solid #f59e0b;
          border-radius: 4px;
          color: #78350f;
          font-size: 13px;
          line-height: 1.5;
        ">
          <strong style="display: block; margin-bottom: 4px;">Observaciones del revisor:</strong>
          ${safeComments}
        </div>
      `;
    }

    bodyDetailsHtml = `
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #334155;">
        Hola <strong>${safeName}</strong>,
      </p>

      <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
        Hemos revisado tu expediente para <strong>${safeBusiness}</strong>. Para poder finalizar tu verificación de manera exitosa, es necesario que reemplaces o vuelvas a cargar los siguientes documentos que se encuentran pendientes o con observaciones.
      </p>

      ${commentsHtml}
      ${missingListHtml}

      <div style="margin: 28px 0; text-align: center;">
        <a href="${safePortalUrl}" style="
          display: inline-block;
          padding: 12px 28px;
          background-color: #d97706;
          color: #ffffff;
          text-decoration: none;
          font-size: 14px;
          font-weight: 600;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(217, 119, 6, 0.2);
        ">
          Subir Documentos Faltantes
        </a>
      </div>
    `;
  }

  const badgeHtml = `
    <div style="margin: 0 0 20px;">
      <span style="
        display: inline-block;
        padding: 4px 12px;
        background-color: ${badgeColorBg};
        color: ${badgeColorFg};
        border-radius: 12px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      ">
        ${badgeText}
      </span>
    </div>
  `;

  const bodyHtml = `
    ${badgeHtml}
    ${bodyDetailsHtml}
    <p style="margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #f1f5f9; color: #94a3b8; font-size: 12px; line-height: 1.4;">
      Si tienes dudas, puedes consultar el estado de tu solicitud directamente en el portal de Fixora.
    </p>
  `;

  return {
    subject,
    text: plainTextBody,
    html: wrapInBaseLayout('Resultado de Verificación', bodyHtml),
  };
}

export async function sendSupplierVerificationResultEmail(
  options: SupplierVerificationResultEmailOptions,
): Promise<void> {
  const rendered = renderSupplierVerificationResultEmail(options);
  await dispatchEmail({
    to: options.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}