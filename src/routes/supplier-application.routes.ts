import { Router } from 'express';
import { supplierApplicationController } from '../controllers/supplier-application.controller.ts';

export const supplierApplicationsRouter = Router();

// Consultar estado de solicitud (por query params ?application_id=... o ?email=...)
supplierApplicationsRouter.get('/status', (req, res, next) =>
  supplierApplicationController.getApplicationStatus(req, res, next),
);

// Consultar solicitud por ID
supplierApplicationsRouter.get('/:id', (req, res, next) =>
  supplierApplicationController.getApplicationById(req, res, next),
);

// Enviar solicitud de registro de proveedor (Asistente web de registro)
supplierApplicationsRouter.post('/', (req, res, next) =>
  supplierApplicationController.submitApplication(req, res, next),
);

export const documentTypesRouter = Router();

// Catálogo de tipos de documento para el asistente de registro
documentTypesRouter.get('/', (req, res, next) =>
  supplierApplicationController.getDocumentTypes(req, res, next),
);
