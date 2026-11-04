import { Resend } from 'resend';
import { ENV } from '../config/env.ts';

// ============================================================
// UTILIDADES
// ============================================================

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getResendClient(): Resend {
  if (!ENV.RESEND_API_KEY || !ENV.RESEND_FROM_EMAIL) {
    throw new Error('La configuración de Resend está incompleta.');
  }

  return new Resend(ENV.RESEND_API_KEY);
}

// ============================================================
// VERIFICACIÓN DE CORREO
// SPRINT 1
// ============================================================

export async function sendVerificationCodeEmail(
  email: string,
  name: string,
  code: string,
): Promise<void> {
  const resend = getResendClient();

  const safeName = escapeHtml(name);
  const safeCode = escapeHtml(code);

  const { error } = await resend.emails.send({
    from: ENV.RESEND_FROM_EMAIL,
    to: email,
    subject: 'Verifica tu correo electrónico - Fixora',

    text: `
Hola ${name},

Gracias por registrarte en Fixora.

Tu código de verificación es: ${code}

Este código vence en ${ENV.EMAIL_VERIFICATION_CODE_TTL_MINUTES} minutos.

Si no solicitaste esta cuenta, puedes ignorar este correo.
    `,

    html: `
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verificación de correo</title>
        </head>

        <body style="
          margin: 0;
          padding: 30px;
          font-family: Arial, sans-serif;
          background-color: #f4f4f5;
        ">
          <div style="
            max-width: 500px;
            margin: auto;
            padding: 30px;
            background-color: #ffffff;
            border-radius: 12px;
          ">
            <h1 style="color: #2563eb; text-align: center;">
              Fixora
            </h1>

            <h2>Verifica tu correo electrónico</h2>

            <p>Hola ${safeName},</p>

            <p>
              Gracias por registrarte en Fixora.
              Para verificar tu dirección de correo electrónico,
              introduce el siguiente código:
            </p>

            <div style="
              margin: 30px 0;
              padding: 20px;
              text-align: center;
              background-color: #f4f4f5;
              border-radius: 8px;
            ">
              <span style="
                font-size: 32px;
                font-weight: bold;
                letter-spacing: 8px;
                color: #2563eb;
              ">
                ${safeCode}
              </span>
            </div>

            <p>
              El código vence en
              <strong>${ENV.EMAIL_VERIFICATION_CODE_TTL_MINUTES} minutos</strong>.
            </p>

            <p style="color: #71717a; font-size: 12px;">
              Si no solicitaste esta cuenta, puedes ignorar este correo.
            </p>
          </div>
        </body>
      </html>
    `,
  });

  if (error) {
    console.error('Error de Resend:', error);
    throw new Error('No fue posible enviar el correo de verificación.');
  }
}

// ============================================================
// RECUPERACIÓN DE CONTRASEÑA
// API-9
// ============================================================

export async function sendPasswordRecoveryCodeEmail(
  email: string,
  code: string,
  expiresInMinutes: number,
): Promise<void> {
  const resend = getResendClient();

  const safeCode = escapeHtml(code);

  const { error } = await resend.emails.send({
    from: ENV.RESEND_FROM_EMAIL,
    to: email,
    subject: 'Recuperación de contraseña - Fixora',

    text: `
Hola,

Hemos recibido una solicitud para restablecer la contraseña
de tu cuenta de Fixora.

Tu código de recuperación es: ${code}

Este código vence en ${expiresInMinutes} minutos.

El código solamente puede utilizarse una vez.

Si no solicitaste este cambio, puedes ignorar este correo.

Atentamente,
Equipo Fixora.
    `,

    html: `
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Recuperación de contraseña</title>
        </head>

        <body style="
          margin: 0;
          padding: 30px;
          font-family: Arial, sans-serif;
          background-color: #f4f4f5;
        ">
          <div style="
            max-width: 500px;
            margin: auto;
            padding: 30px;
            background-color: #ffffff;
            border-radius: 12px;
          ">
            <h1 style="
              color: #2563eb;
              text-align: center;
            ">
              Fixora
            </h1>

            <h2>Recuperación de contraseña</h2>

            <p>Hola,</p>

            <p>
              Hemos recibido una solicitud para restablecer
              la contraseña de tu cuenta de Fixora.
            </p>

            <p>
              Introduce el siguiente código para continuar:
            </p>

            <div style="
              margin: 30px 0;
              padding: 20px;
              text-align: center;
              background-color: #f4f4f5;
              border-radius: 8px;
            ">
              <span style="
                font-size: 32px;
                font-weight: bold;
                letter-spacing: 8px;
                color: #2563eb;
              ">
                ${safeCode}
              </span>
            </div>

            <p>
              Este código vence en
              <strong>${expiresInMinutes} minutos</strong>.
            </p>

            <p>
              El código solamente puede utilizarse una vez.
            </p>

            <p style="
              color: #71717a;
              font-size: 12px;
            ">
              Si no solicitaste este cambio, puedes ignorar este correo.
              Tu contraseña no será modificada.
            </p>

          </div>
        </body>
      </html>
    `,
  });

  if (error) {
    console.error('Error de Resend:', error);
    throw new Error('No fue posible enviar el correo de recuperación.');
  }
}
