
import 'dotenv/config';

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

import { db } from '../config/database.ts';

import {
  roles,
  categories,
  type_documents,
} from './schema/index.ts';

import {
  users,
  personal_data,
} from './schema/tables.ts';

// ============================================================================
// ADMINISTRADOR PRINCIPAL
// ============================================================================

async function seedPrincipalAdministrator() {
  console.log('Creando administrador principal...');

  const email = process.env.ADMIN_PRINCIPAL_EMAIL
    ?.trim()
    .toLowerCase();

  const password = process.env.ADMIN_PRINCIPAL_PASSWORD;

  const name =
    process.env.ADMIN_PRINCIPAL_NAME?.trim() || 'Administrador';

  const lastname_p =
    process.env.ADMIN_PRINCIPAL_LASTNAME_P?.trim() || 'Principal';

  const lastname_m =
    process.env.ADMIN_PRINCIPAL_LASTNAME_M?.trim() || null;

  const birth_date =
    process.env.ADMIN_PRINCIPAL_BIRTH_DATE?.trim() || null;

  const phone =
    process.env.ADMIN_PRINCIPAL_PHONE?.trim() || null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'ADMIN_PRINCIPAL_EMAIL no está configurado correctamente.',
    );
  }

  // Buscar el rol Administrador.
  const [adminRole] = await db
    .select()
    .from(roles)
    .where(eq(roles.name, 'administrador'))
    .limit(1);

  if (!adminRole || !adminRole.active) {
    throw new Error(
      'El rol administrador no existe o está desactivado.',
    );
  }

  // Comprobar si el administrador principal ya existe.
  const [existingAdmin] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingAdmin) {
    // No promover automáticamente una cuenta de otro rol.
    if (existingAdmin.role_id !== adminRole.UniqueID) {
      throw new Error(
        'El correo configurado para el administrador principal ya pertenece a una cuenta con otro rol.',
      );
    }

    if (String(existingAdmin.state).toLowerCase() !== 'activo') {
      throw new Error(
        'La cuenta del administrador principal existe, pero no está activa.',
      );
    }

    // Comprobar si ya tiene datos personales.
    const [existingPersonalData] = await db
      .select()
      .from(personal_data)
      .where(
        eq(personal_data.user_id, existingAdmin.UniqueID),
      )
      .limit(1);

    // Crear datos personales solamente si todavía no existen.
    if (!existingPersonalData) {
      await db.insert(personal_data).values({
        user_id: existingAdmin.UniqueID,
        name,
        lastname_p,
        lastname_m,
        birth_date,
        phone,
      });
    }

    console.log(
      'El administrador principal ya existe. No se realizaron cambios.',
    );

    return;
  }

  // La contraseña solamente es necesaria cuando se crea la cuenta.
  if (
    !password ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    throw new Error(
      'ADMIN_PRINCIPAL_PASSWORD debe tener al menos 8 caracteres y no superar 72 bytes.',
    );
  }

  if (!name || name.length > 100 || !lastname_p || lastname_p.length > 100) {
    throw new Error(
      'Los datos personales del administrador principal no son válidos.',
    );
  }

  if (lastname_m && lastname_m.length > 100) {
    throw new Error(
      'El apellido materno del administrador principal supera los 100 caracteres.',
    );
  }

  if (phone && !/^\d{10}$/.test(phone)) {
    throw new Error(
      'ADMIN_PRINCIPAL_PHONE debe contener exactamente 10 dígitos.',
    );
  }

  if (birth_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) {
      throw new Error(
        'ADMIN_PRINCIPAL_BIRTH_DATE debe utilizar el formato YYYY-MM-DD.',
      );
    }

    const [year, month, day] = birth_date.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getTime() > Date.now()
    ) {
      throw new Error(
        'La fecha de nacimiento del administrador principal no es válida.',
      );
    }
  }

  // Generar hash de la contraseña.
  const passwordHash = await bcrypt.hash(password, 12);

  // Crear usuario y datos personales en una transacción.
  await db.transaction(async (tx) => {
    const [createdAdmin] = await tx
      .insert(users)
      .values({
        email,
        password_hash: passwordHash,
        role_id: adminRole.UniqueID,
        state: 'activo',
        failed_attempts: 0,
        locked_until: null,
      })
      .returning({
        id: users.UniqueID,
      });

    await tx.insert(personal_data).values({
      user_id: createdAdmin.id,
      name,
      lastname_p,
      lastname_m,
      birth_date,
      phone,
    });
  });

  console.log('Administrador principal creado correctamente.');
}

// ============================================================================
// SEED PRINCIPAL
// ============================================================================

async function seed() {
  console.log('🌱 Iniciando carga de datos semilla (seeds)...');

  // 1. Roles
  console.log('Insertando catálogo de roles...');

  const initialRoles = [
    { name: 'cliente', active: true },
    { name: 'proveedor', active: true },
    { name: 'gerente', active: true },
    { name: 'empleado', active: true },
    { name: 'administrador', active: true },
    { name: 'soporte', active: true },
  ];

  for (const role of initialRoles) {
    await db
      .insert(roles)
      .values(role)
      .onConflictDoNothing({
        target: roles.name,
      });
  }

  // 2. Administrador principal
  await seedPrincipalAdministrator();

  // 3. Categorías
  console.log('Insertando catálogo de categorías...');

  const initialCategories = [
    { name: 'Plomería', slug: 'plomeria', sort_order: 1, active: true },
    { name: 'Electricidad', slug: 'electricidad', sort_order: 2, active: true },
    { name: 'Cerrajería', slug: 'cerrajeria', sort_order: 3, active: true },
    {
      name: 'Climatización',
      slug: 'climatizacion',
      sort_order: 4,
      active: true,
    },
    {
      name: 'Pintura e Impermeabilización',
      slug: 'pintura-impermeabilizacion',
      sort_order: 5,
      active: true,
    },
    { name: 'Carpintería', slug: 'carpinteria', sort_order: 6, active: true },
    { name: 'Albañilería', slug: 'albanileria', sort_order: 7, active: true },
    {
      name: 'Electrodomésticos',
      slug: 'electrodomesticos',
      sort_order: 8,
      active: true,
    },
    { name: 'Jardinería', slug: 'jardineria', sort_order: 9, active: true },
    {
      name: 'Limpieza y Desinfección',
      slug: 'limpieza-desinfeccion',
      sort_order: 10,
      active: true,
    },
  ];

  for (const cat of initialCategories) {
    await db
      .insert(categories)
      .values(cat)
      .onConflictDoNothing({
        target: categories.slug,
      });
  }

  // 4. Tipos de documento
  console.log('Insertando catálogo de tipos de documento...');

  const initialDocTypes = [
    {
      name: 'Identificación Oficial (INE / Pasaporte)',
      description: 'Documento de identidad oficial vigente del titular o representante legal.',
      requires_expiration_date: true,
      supplier_type: 'ambos' as const,
      mandatory: true,
      active: true,
    },
    {
      name: 'Comprobante de Domicilio',
      description: 'Comprobante de luz, agua o teléfono no mayor a 3 meses de antigüedad.',
      requires_expiration_date: false,
      supplier_type: 'ambos' as const,
      mandatory: true,
      active: true,
    },
    {
      name: 'Constancia de Situación Fiscal (RFC)',
      description: 'Documento emitido por el SAT con antigüedad no mayor a 3 meses.',
      requires_expiration_date: false,
      supplier_type: 'ambos' as const,
      mandatory: true,
      active: true,
    },
    {
      name: 'Acta Constitutiva',
      description: 'Escritura pública que acredita la constitución legal de la empresa.',
      requires_expiration_date: false,
      supplier_type: 'empresa' as const,
      mandatory: true,
      active: true,
    },
    {
      name: 'Poder Notarial del Representante Legal',
      description: 'Facultades notariales otorgadas al representante de la empresa.',
      requires_expiration_date: false,
      supplier_type: 'empresa' as const,
      mandatory: true,
      active: true,
    },
    {
      name: 'Carta de No Antecedentes Penales',
      description: 'Documento expedido por autoridad oficial competente.',
      requires_expiration_date: true,
      supplier_type: 'independiente' as const,
      mandatory: false,
      active: true,
    },
    {
      name: 'Certificaciones o Títulos Técnicos',
      description: 'Certificados de especialidad, cursos o grados en oficios y profesiones.',
      requires_expiration_date: false,
      supplier_type: 'ambos' as const,
      mandatory: false,
      active: true,
    },
    {
      name: 'Póliza de Seguro de Responsabilidad Civil',
      description:
        'Póliza vigente que respalde daños a terceros durante la prestación del servicio.',
      requires_expiration_date: true,
      supplier_type: 'empresa' as const,
      mandatory: false,
      active: true,
    },
  ];

  for (const doc of initialDocTypes) {
    await db
      .insert(type_documents)
      .values(doc)
      .onConflictDoNothing();
  }

  console.log('✅ Datos semilla insertados correctamente.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Error al ejecutar los datos semilla:', err);
  process.exit(1);
});
