import { and, asc, eq, ilike, ne } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { categories } from '../database/schema/tables.ts';

// ============================================================
// ERRORES DEL MÓDULO
// ============================================================

export class CategoryError extends Error {
  public statusCode: number;
  public code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);

    this.name = 'CategoryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ============================================================
// TIPOS DE ENTRADA
// ============================================================

export interface CreateCategoryInput {
  name: string;
  slug?: string;
  icon_key?: string | null;
  sort_order?: number;
  active?: boolean;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  icon_key?: string | null;
  sort_order?: number;
  active?: boolean;
}

// ============================================================
// SERIALIZACIÓN
// ============================================================

function serializeCategory(category: typeof categories.$inferSelect) {
  const { UniqueID, ...rest } = category;

  return {
    ...rest,
    id: String(UniqueID),
  };
}

// ============================================================
// VALIDACIONES
// ============================================================

function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_INPUT',
      'El nombre de la categoría es obligatorio.',
    );
  }

  const name = value.trim();

  if (name.length < 2 || name.length > 150) {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_INPUT',
      'El nombre debe tener entre 2 y 150 caracteres.',
    );
  }

  return name;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateSlug(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CategoryError(400, 'CATEGORY_INVALID_INPUT', 'El slug debe ser un texto válido.');
  }

  const slug = slugify(value);

  if (!slug || slug.length > 150) {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_INPUT',
      'El slug debe tener entre 1 y 150 caracteres válidos.',
    );
  }

  return slug;
}

function validateIconKey(value: unknown): string | null {
  if (value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new CategoryError(400, 'CATEGORY_INVALID_INPUT', 'La llave del ícono debe ser un texto.');
  }

  const iconKey = value.trim();

  if (iconKey.length > 500) {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_INPUT',
      'La llave del ícono no puede superar 500 caracteres.',
    );
  }

  return iconKey || null;
}

function validateSortOrder(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_INPUT',
      'El orden debe ser un entero mayor o igual a cero.',
    );
  }

  return value;
}

function validateActive(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new CategoryError(400, 'CATEGORY_INVALID_INPUT', 'El estado debe ser verdadero o falso.');
  }

  return value;
}

function validateCategoryId(id: bigint): void {
  const value = id.toString();

  if (id <= 0n || value.length > 18) {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_ID',
      'El identificador de categoría no es válido.',
    );
  }
}

// ============================================================
// VALIDAR UNICIDAD DEL SLUG
// ============================================================

async function ensureUniqueSlug(slug: string, currentId?: bigint): Promise<void> {
  const condition =
    currentId !== undefined
      ? and(eq(categories.slug, slug), ne(categories.UniqueID, currentId))
      : eq(categories.slug, slug);

  const [existing] = await db
    .select({
      UniqueID: categories.UniqueID,
    })
    .from(categories)
    .where(condition)
    .limit(1);

  if (existing) {
    throw new CategoryError(409, 'CATEGORY_SLUG_TAKEN', 'Ya existe una categoría con ese slug.');
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const current = error as {
    code?: string;
    cause?: {
      code?: string;
    };
  };

  return current.code === '23505' || current.cause?.code === '23505';
}

// ============================================================
// CONSULTAR CATEGORÍAS PÚBLICAS
// ============================================================

export async function getPublicCategories() {
  const result = await db
    .select()
    .from(categories)
    .where(eq(categories.active, true))
    .orderBy(asc(categories.sort_order), asc(categories.name));

  return result.map(serializeCategory);
}

// ============================================================
// CONSULTAR TODAS LAS CATEGORÍAS
// ============================================================

export async function getAllCategories(search?: string) {
  const result = search
    ? await db
        .select()
        .from(categories)
        .where(ilike(categories.name, `%${search}%`))
        .orderBy(asc(categories.sort_order), asc(categories.name))
    : await db.select().from(categories).orderBy(asc(categories.sort_order), asc(categories.name));

  return result.map(serializeCategory);
}

// ============================================================
// CONSULTAR UNA CATEGORÍA ACTIVA
// ============================================================

export async function getCategoryById(id: bigint) {
  validateCategoryId(id);

  const [category] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.UniqueID, id), eq(categories.active, true)))
    .limit(1);

  if (!category) {
    throw new CategoryError(404, 'CATEGORY_NOT_FOUND', 'Categoría no encontrada.');
  }

  return serializeCategory(category);
}

// ============================================================
// CREAR CATEGORÍA
// ============================================================

export async function createCategory(input: CreateCategoryInput) {
  const name = validateName(input.name);

  const slug = input.slug !== undefined ? validateSlug(input.slug) : validateSlug(name);

  const icon_key = input.icon_key === undefined ? null : validateIconKey(input.icon_key);

  const sort_order = input.sort_order === undefined ? 0 : validateSortOrder(input.sort_order);

  const active = input.active === undefined ? true : validateActive(input.active);

  await ensureUniqueSlug(slug);

  try {
    const [created] = await db
      .insert(categories)
      .values({
        name,
        slug,
        icon_key,
        sort_order,
        active,
      })
      .returning();

    if (!created) {
      throw new Error('No se pudo crear la categoría.');
    }

    return serializeCategory(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CategoryError(409, 'CATEGORY_SLUG_TAKEN', 'Ya existe una categoría con ese slug.');
    }

    throw error;
  }
}

// ============================================================
// ACTUALIZAR CATEGORÍA
// ============================================================

export async function updateCategory(id: bigint, input: UpdateCategoryInput) {
  validateCategoryId(id);

  const [existing] = await db.select().from(categories).where(eq(categories.UniqueID, id)).limit(1);

  if (!existing) {
    throw new CategoryError(404, 'CATEGORY_NOT_FOUND', 'Categoría no encontrada.');
  }

  const values: Partial<typeof categories.$inferInsert> = {};

  if (input.name !== undefined) {
    values.name = validateName(input.name);
  }

  // El slug permanece igual al cambiar el nombre,
  // salvo que se envíe uno nuevo explícitamente.
  if (input.slug !== undefined) {
    values.slug = validateSlug(input.slug);
  }

  if (values.slug !== undefined) {
    await ensureUniqueSlug(values.slug, id);
  }

  if (input.icon_key !== undefined) {
    values.icon_key = validateIconKey(input.icon_key);
  }

  if (input.sort_order !== undefined) {
    values.sort_order = validateSortOrder(input.sort_order);
  }

  if (input.active !== undefined) {
    values.active = validateActive(input.active);
  }

  if (Object.keys(values).length === 0) {
    throw new CategoryError(
      400,
      'CATEGORY_INVALID_INPUT',
      'Debes proporcionar al menos un campo para actualizar.',
    );
  }

  try {
    const [updated] = await db
      .update(categories)
      .set(values)
      .where(eq(categories.UniqueID, id))
      .returning();

    if (!updated) {
      throw new CategoryError(404, 'CATEGORY_NOT_FOUND', 'Categoría no encontrada.');
    }

    return serializeCategory(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CategoryError(409, 'CATEGORY_SLUG_TAKEN', 'Ya existe una categoría con ese slug.');
    }

    throw error;
  }
}

// ============================================================
// DESACTIVAR CATEGORÍA
// ============================================================

export async function deactivateCategory(id: bigint) {
  validateCategoryId(id);

  const [existing] = await db.select().from(categories).where(eq(categories.UniqueID, id)).limit(1);

  if (!existing) {
    throw new CategoryError(404, 'CATEGORY_NOT_FOUND', 'Categoría no encontrada.');
  }

  if (!existing.active) {
    throw new CategoryError(
      409,
      'CATEGORY_ALREADY_INACTIVE',
      'La categoría ya se encuentra desactivada.',
    );
  }

  const [updated] = await db
    .update(categories)
    .set({
      active: false,
    })
    .where(eq(categories.UniqueID, id))
    .returning();

  if (!updated) {
    throw new CategoryError(404, 'CATEGORY_NOT_FOUND', 'Categoría no encontrada.');
  }

  return serializeCategory(updated);
}
