import { Resend } from 'resend';
import { ENV } from '../config/env.ts';

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export async function sendVerificationCodeEmail(
    email: string,
    name: string,
    code: string,
): Promise<void> {
    if (!ENV.RESEND_API_KEY || !ENV.RESEND_FROM_EMAIL) {
        throw new Error('La configuración de Resend está incompleta.');
    }

    const resend = new Resend(ENV.RESEND_API_KEY);

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