import type { Request, Response } from 'express';

import {
  CategoryError,
  getPublicCategories,
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deactivateCategory,
} from '../services/categories.service.ts';

// ============================================================
// VALIDAR IDENTIFICADOR
// ============================================================

function parseCategoryId(value: string): bigint | null {
  if (!/^[1-9]\d{0,17}$/.test(value)) {
    return null;
  }

  return BigInt(value);
}

// ============================================================
// MANEJO DE ERRORES
// ============================================================

function handleError(res: Response, error: unknown) {
  if (error instanceof CategoryError) {
    return res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
  }

  console.error('Error en el módulo de categorías:', error);

  return res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'Error interno del servidor.',
  });
}

// ============================================================
// RESPUESTA PARA IDENTIFICADORES INVÁLIDOS
// ============================================================

function invalidCategoryId(res: Response) {
  return res.status(400).json({
    error: 'CATEGORY_INVALID_ID',
    message: 'El identificador de categoría no es válido.',
  });
}

// ============================================================
// CONSULTAR CATEGORÍAS PÚBLICAS
// GET /api/categories
// ============================================================

export async function listPublic(_req: Request, res: Response) {
  try {
    const data = await getPublicCategories();

    return res.status(200).json({
      success: true,
      message: 'Categorías obtenidas correctamente.',
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ============================================================
// CONSULTAR TODAS LAS CATEGORÍAS
// GET /api/categories/admin/all
// ============================================================

export async function listAdmin(req: Request, res: Response) {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

    const data = await getAllCategories(search);

    return res.status(200).json({
      success: true,
      message: 'Listado de categorías obtenido correctamente.',
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ============================================================
// CONSULTAR UNA CATEGORÍA
// GET /api/categories/:id
// ============================================================

export async function getOne(req: Request, res: Response) {
  try {
    const paramId = req.params.id;

    if (typeof paramId !== 'string') {
      return invalidCategoryId(res);
    }

    const id = parseCategoryId(paramId);

    if (id === null) {
      return invalidCategoryId(res);
    }

    const data = await getCategoryById(id);

    return res.status(200).json({
      success: true,
      message: 'Categoría obtenida correctamente.',
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ============================================================
// CREAR CATEGORÍA
// POST /api/categories
// ============================================================

export async function create(req: Request, res: Response) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: 'CATEGORY_INVALID_INPUT',
        message: 'El cuerpo de la solicitud no es válido.',
      });
    }

    const data = await createCategory(req.body);

    return res.status(201).json({
      success: true,
      message: 'Categoría creada correctamente.',
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ============================================================
// ACTUALIZAR CATEGORÍA
// PATCH /api/categories/:id
// ============================================================

export async function update(req: Request, res: Response) {
  try {
    const paramId = req.params.id;

    if (typeof paramId !== 'string') {
      return invalidCategoryId(res);
    }

    const id = parseCategoryId(paramId);

    if (id === null) {
      return invalidCategoryId(res);
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: 'CATEGORY_INVALID_INPUT',
        message: 'El cuerpo de la solicitud no es válido.',
      });
    }

    const data = await updateCategory(id, req.body);

    return res.status(200).json({
      success: true,
      message: 'Categoría actualizada correctamente.',
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ============================================================
// DESACTIVAR CATEGORÍA
// DELETE /api/categories/:id
// ============================================================

export async function deactivate(req: Request, res: Response) {
  try {
    const paramId = req.params.id;

    if (typeof paramId !== 'string') {
      return invalidCategoryId(res);
    }

    const id = parseCategoryId(paramId);

    if (id === null) {
      return invalidCategoryId(res);
    }

    const data = await deactivateCategory(id);

    return res.status(200).json({
      success: true,
      message: 'Categoría desactivada correctamente.',
      data,
    });
  } catch (error) {
    return handleError(res, error);
  }
}
