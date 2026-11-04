import { Router } from 'express';
import { storageController } from '../controllers/storage.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { handleUploadErrors } from '../middlewares/upload.middleware.ts';

export const storageRouter = Router();

// Subir un archivo (requiere sesión activa)
storageRouter.post('/upload', authenticateToken, handleUploadErrors, (req, res, next) =>
  storageController.upload(req, res, next),
);

// Solicitar enlace firmado con vigencia (requiere sesión activa; verificación solo admin)
storageRouter.post('/signed-url', authenticateToken, (req, res, next) =>
  storageController.getSignedUrl(req, res, next),
);

// Descargar archivo mediante enlace firmado
storageRouter.get('/download', (req, res, next) => storageController.download(req, res, next));

// Previsualizar archivo en navegador mediante enlace firmado
storageRouter.get('/view', (req, res, next) => {
  req.query.disposition = 'inline';
  storageController.download(req, res, next);
});

// Eliminar archivo (requiere sesión activa)
storageRouter.delete('/', authenticateToken, (req, res, next) =>
  storageController.deleteFile(req, res, next),
);
