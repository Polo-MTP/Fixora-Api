
import { Router } from 'express';

import * as categoriesController from '../controllers/categories.controller.ts';

// IMPORTANTE:
// Ajustar los nombres de estas importaciones a los middlewares
// reales que ya existen en tu proyecto.

import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

const router = Router();

// ============================================================
// RUTAS PÚBLICAS
// ============================================================

// Consultar únicamente categorías activas.
router.get(
    '/',
    categoriesController.listPublic
);

// Consultar una categoría activa por ID.
router.get(
    '/:id',
    categoriesController.getOne
);

// ============================================================
// RUTAS ADMINISTRATIVAS
// ============================================================

// Consultar categorías activas e inactivas.
router.get(
    '/admin/all',
    authenticateToken,
    authorizeRoles('administrador'),
    categoriesController.listAdmin
);

// Crear categoría.
router.post(
    '/',
    authenticateToken,
    authorizeRoles('administrador'),
    categoriesController.create
);

// Actualizar categoría.
router.patch(
    '/:id',
    authenticateToken,
    authorizeRoles('administrador'),
    categoriesController.update
);

// Desactivar categoría.
router.delete(
    '/:id',
    authenticateToken,
    authorizeRoles('administrador'),
    categoriesController.deactivate
);

export default router;
