import type { Request, Response, NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { BadRequestError } from '../errors/app-error.ts';

// Configuración de multer con almacenamiento en memoria
const storage = multer.memoryStorage();

// Límite superior global para evitar sobrecarga (25 MB)
const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
});

export const multerSingleFile = upload.single('file');

/**
 * Middleware que intercepta y formatea los errores propios de Multer
 */
export function handleUploadErrors(req: Request, res: Response, next: NextFunction): void {
  multerSingleFile(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new BadRequestError(
              'El archivo excede el límite de tamaño permitido para la plataforma (máximo 25 MB).',
            ),
          );
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(
            new BadRequestError(
              `Campo de formulario no esperado (${err.field}). Debes enviar el archivo en el campo 'file'.`,
            ),
          );
        }
        return next(new BadRequestError(`Error al procesar el archivo: ${err.message}`));
      }
      return next(err);
    }

    if (!req.file) {
      return next(new BadRequestError("Debes adjuntar un archivo en el campo 'file'."));
    }

    next();
  });
}
