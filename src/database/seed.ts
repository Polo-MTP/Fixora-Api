import { db } from '../config/database.ts';
import { roles, categories, type_documents } from './schema/index.ts';

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
    await db.insert(roles).values(role).onConflictDoNothing({ target: roles.name });
  }

  // 2. Categorías
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
    await db.insert(categories).values(cat).onConflictDoNothing({ target: categories.slug });
  }

  // 3. Tipos de documento
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
    await db.insert(type_documents).values(doc).onConflictDoNothing();
  }

  console.log('✅ Datos semilla insertados correctamente.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Error al ejecutar los datos semilla:', err);
  process.exit(1);
});
