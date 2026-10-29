import { sql } from 'drizzle-orm';
import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  text,
  boolean,
  date,
  time,
  timestamp,
  uuid,
  numeric,
  integer,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  userStateEnum,
  devicePlatformEnum,
  sanctionTypeEnum,
  scheduleBlockReasonEnum,
  supplierTypeEnum,
  supplierApplicationStateEnum,
  docSupplierTypeEnum,
  serviceRequestStatusEnum,
  canceledByEnum,
  attachmentMimeTypeEnum,
  requestAttachmentKindEnum,
  priceAdjustmentReasonEnum,
  priceAdjustmentStatusEnum,
  paymentStatusEnum,
  paymentMethodEnum,
  incomeRecordStatusEnum,
  commissionStatusEnum,
  dispatchResponseEnum,
  reviewDirectionEnum,
  reviewStatusEnum,
  reportCategoryEnum,
  reportPriorityEnum,
  reportStatusEnum,
  reportResolutionTypeEnum,
  reportEventTypeEnum,
} from './enums.ts';

// ============================================================================
// MÓDULO: Cuentas, roles y accesos (Parte 1: Base)
// ============================================================================

export const roles = pgTable('roles', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  active: boolean('active').notNull().default(true),
});

export const users = pgTable('users', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password_hash: varchar('password_hash', { length: 255 }).notNull(),
  role_id: bigint('role_id', { mode: 'bigint' }).references(() => roles.UniqueID),
  state: userStateEnum('state').notNull().default('por_verificar'),
  failed_attempts: integer('failed_attempts').notNull().default(0),
  locked_until: timestamp('locked_until'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),

  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),

  refresh_hash: varchar('refresh_hash', { length: 64 }).notNull(),
  expires_at: timestamp('expires_at').notNull(),
  revoked: boolean('revoked').notNull().default(false),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

export const personal_data = pgTable('personal_data', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  name: varchar('name', { length: 100 }).notNull(),
  lastname_p: varchar('lastname_p', { length: 100 }).notNull(),
  lastname_m: varchar('lastname_m', { length: 100 }),
  birth_date: date('birth_date'),
  phone: varchar('phone', { length: 30 }),
});

export const notifications = pgTable('notifications', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  type: varchar('type', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  entity_type: varchar('entity_type', { length: 100 }),
  entity_id: bigint('entity_id', { mode: 'bigint' }), // Relación polimórfica
  read_at: timestamp('read_at'),
});

export const addresses = pgTable('addresses', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  reference: varchar('reference', { length: 255 }),
  street: varchar('street', { length: 255 }).notNull(),
  num_ext: varchar('num_ext', { length: 50 }).notNull(),
  num_int: varchar('num_int', { length: 50 }),
  colony: varchar('colony', { length: 150 }).notNull(),
  municipality: varchar('municipality', { length: 150 }).notNull(),
  state: varchar('state', { length: 150 }).notNull(),
  postal_code: varchar('postal_code', { length: 20 }).notNull(),
  country: varchar('country', { length: 100 }).notNull().default('México'),
  latitude: numeric('latitude', { precision: 10, scale: 7 }),
  longitude: numeric('longitude', { precision: 10, scale: 7 }),
  active: boolean('active').notNull().default(true),
});

export const address_user = pgTable('address_user', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  address_id: bigint('address_id', { mode: 'bigint' })
    .notNull()
    .references(() => addresses.UniqueID),
  alias: varchar('alias', { length: 100 }),
  is_main: boolean('is_main').notNull().default(false),
  active: boolean('active').notNull().default(true),
});

export const device_tokens = pgTable('device_tokens', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  token: varchar('token', { length: 500 }).notNull(),
  platform: devicePlatformEnum('platform').notNull(),
  active: boolean('active').notNull().default(true),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// MÓDULO: Negocios y sucursales
// ============================================================================

export const business = pgTable('business', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  tax_identification: varchar('tax_identification', { length: 50 }).unique(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 30 }),
});

export const branches = pgTable('branches', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  business_id: bigint('business_id', { mode: 'bigint' })
    .notNull()
    .references(() => business.UniqueID),
  address_id: bigint('address_id', { mode: 'bigint' })
    .notNull()
    .references(() => addresses.UniqueID),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 30 }),
  timezone: varchar('timezone', { length: 100 }).notNull().default('America/Mexico_City'),
  total_jobs: bigint('total_jobs', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  accepting_request: boolean('accepting_request').notNull().default(true),
  description: text('description'),
  logo_key: varchar('logo_key', { length: 500 }),
  email: varchar('email', { length: 255 }),
  rating_avg: numeric('rating_avg', { precision: 3, scale: 2 }).default('0.00'),
  reviews_count: integer('reviews_count').notNull().default(0),
});

export const branch_schedules = pgTable('branch_schedules', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  branch_id: bigint('branch_id', { mode: 'bigint' })
    .notNull()
    .references(() => branches.UniqueID),
  day_of_week: integer('day_of_week').notNull(),
  open_time: time('open_time').notNull(),
  close_time: time('close_time').notNull(),
  active: boolean('active').notNull().default(true),
});

export const categories = pgTable('categories', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  name: varchar('name', { length: 150 }).notNull(),
  slug: varchar('slug', { length: 150 }).notNull().unique(),
  active: boolean('active').notNull().default(true),
  icon_key: varchar('icon_key', { length: 500 }),
  sort_order: integer('sort_order').notNull().default(0),
});

export const branches_categories = pgTable('branches_categories', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  category_id: bigint('category_id', { mode: 'bigint' })
    .notNull()
    .references(() => categories.UniqueID),
  branch_id: bigint('branch_id', { mode: 'bigint' })
    .notNull()
    .references(() => branches.UniqueID),
  base_price: numeric('base_price', { precision: 12, scale: 2 }).notNull(),
  active: boolean('active').notNull().default(true),
  duration_minutes: integer('duration_minutes').notNull().default(60),
});

export const portfolio_works = pgTable('portfolio_works', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  branch_id: bigint('branch_id', { mode: 'bigint' })
    .notNull()
    .references(() => branches.UniqueID),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
});

export const portfolio_media = pgTable('portfolio_media', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  work_id: bigint('work_id', { mode: 'bigint' })
    .notNull()
    .references(() => portfolio_works.UniqueID),
  file_key: varchar('file_key', { length: 500 }).notNull(),
  description: text('description'),
});

// ============================================================================
// MÓDULO: Personal (Parte 1: Base)
// ============================================================================

export const employees = pgTable('employees', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  branch_id: bigint('branch_id', { mode: 'bigint' })
    .notNull()
    .references(() => branches.UniqueID),
  can_attend: boolean('can_attend').notNull().default(true),
  active: boolean('active').notNull().default(true),
});

// ============================================================================
// MÓDULO: Registro y verificación de proveedores
// ============================================================================

export const suppliers = pgTable('suppliers', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  supplier_type: supplierTypeEnum('supplier_type').notNull(),
  rfc: varchar('rfc', { length: 50 }).unique(),
  active: boolean('active').notNull().default(true),
});

export const supplier_applications = pgTable('supplier_applications', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  reviewed_by: bigint('reviewed_by', { mode: 'bigint' }).references(() => users.UniqueID),
  supplier_id: bigint('supplier_id', { mode: 'bigint' })
    .notNull()
    .references(() => suppliers.UniqueID),
  supplier_type: supplierTypeEnum('supplier_type').notNull(),
  state: supplierApplicationStateEnum('state').notNull().default('pendiente'),
  comments: text('comments'),
  application_date: date('application_date').notNull(),
  due_date: date('due_date'),
});

export const business_supplier = pgTable('business_supplier', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  business_id: bigint('business_id', { mode: 'bigint' })
    .notNull()
    .references(() => business.UniqueID),
  supplier_id: bigint('supplier_id', { mode: 'bigint' })
    .notNull()
    .references(() => suppliers.UniqueID),
  active: boolean('active').notNull().default(true),
});

export const type_documents = pgTable('type_documents', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  name: varchar('name', { length: 150 }).notNull(),
  description: text('description'),
  requires_expiration_date: boolean('requires_expiration_date').notNull().default(false),
  supplier_type: docSupplierTypeEnum('supplier_type').notNull().default('ambos'),
  mandatory: boolean('mandatory').notNull().default(true),
  active: boolean('active').notNull().default(true),
});

export const supplier_documents = pgTable('supplier_documents', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  supplier_id: bigint('supplier_id', { mode: 'bigint' })
    .notNull()
    .references(() => suppliers.UniqueID),
  type_document_id: bigint('type_document_id', { mode: 'bigint' })
    .notNull()
    .references(() => type_documents.UniqueID),
  file_key: varchar('file_key', { length: 500 }).notNull(),
  file_hash: varchar('file_hash', { length: 128 }),
  upload_date: date('upload_date').notNull(),
  due_date: date('due_date'),
  is_public: boolean('is_public').notNull().default(false),
});

export const document_validations = pgTable('document_validations', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  document_id: bigint('document_id', { mode: 'bigint' })
    .notNull()
    .references(() => supplier_documents.UniqueID),
  result: varchar('result', { length: 50 }).notNull(),
  reviewed_by: bigint('reviewed_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  comment: text('comment'),
  reviewed_at: timestamp('reviewed_at').notNull().defaultNow(),
});

// ============================================================================
// MÓDULO: Personal (Parte 2: Dependientes de supplier_documents)
// ============================================================================

export const employee_profiles = pgTable('employee_profiles', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  employee_id: bigint('employee_id', { mode: 'bigint' })
    .notNull()
    .references(() => employees.UniqueID),
  photo_key: varchar('photo_key', { length: 500 }),
  photo_document_id: bigint('photo_document_id', { mode: 'bigint' }).references(
    () => supplier_documents.UniqueID,
  ),
  bio: text('bio'),
});

export const employee_vehicles = pgTable('employee_vehicles', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  employee_id: bigint('employee_id', { mode: 'bigint' })
    .notNull()
    .references(() => employees.UniqueID),
  plate: varchar('plate', { length: 50 }).notNull(),
  brand: varchar('brand', { length: 100 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  color: varchar('color', { length: 50 }).notNull(),
  active: boolean('active').notNull().default(true),
});

export const schedule_blocks = pgTable('schedule_blocks', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  employee_id: bigint('employee_id', { mode: 'bigint' })
    .notNull()
    .references(() => employees.UniqueID),
  starts_at: timestamp('starts_at').notNull(),
  ends_at: timestamp('ends_at').notNull(),
  reason: scheduleBlockReasonEnum('reason').notNull(),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// MÓDULO: Servicio
// ============================================================================

export const service_requests = pgTable('service_requests', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  client_id: bigint('client_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  category_id: bigint('category_id', { mode: 'bigint' })
    .notNull()
    .references(() => categories.UniqueID),
  branch_id: bigint('branch_id', { mode: 'bigint' })
    .notNull()
    .references(() => branches.UniqueID),
  address_id: bigint('address_id', { mode: 'bigint' })
    .notNull()
    .references(() => addresses.UniqueID),
  employee_id: bigint('employee_id', { mode: 'bigint' }).references(() => employees.UniqueID),
  is_emergency: boolean('is_emergency').notNull().default(false),
  description: text('description').notNull(),
  status: serviceRequestStatusEnum('status').notNull().default('pendiente'),
  expires_at: timestamp('expires_at'),
  canceled_by: canceledByEnum('canceled_by'),
  canceled_reason: text('canceled_reason'),
  agreed_price: numeric('agreed_price', { precision: 12, scale: 2 }),
  created_at: timestamp('created_at').notNull().defaultNow(),
  scheduled_at: timestamp('scheduled_at'),
  scheduled_end: timestamp('scheduled_end'),
  completed_at: timestamp('completed_at'),
  total_amount: numeric('total_amount', { precision: 12, scale: 2 }),
  client_uuid: varchar('client_uuid', { length: 100 }),
  accepted_at: timestamp('accepted_at'),
  arrived_at: timestamp('arrived_at'),
});

export const request_attachments = pgTable('request_attachments', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  file_key: varchar('file_key', { length: 500 }).notNull(),
  mime_type: attachmentMimeTypeEnum('mime_type').notNull(),
  size_bytes: integer('size_bytes'),
  caption: varchar('caption', { length: 500 }),
  created_at: timestamp('created_at').notNull().defaultNow(),
  kind: requestAttachmentKindEnum('kind').notNull(),
});

export const price_adjustment = pgTable('price_adjustment', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  reason: priceAdjustmentReasonEnum('reason').notNull(),
  status: priceAdjustmentStatusEnum('status').notNull().default('pendiente'),
  declared_by: bigint('declared_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  paid_at: timestamp('paid_at'),
});

export const service_payments = pgTable('service_payments', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  status: paymentStatusEnum('status').notNull().default('pendiente'),
  method: paymentMethodEnum('method').notNull(),
  reference: varchar('reference', { length: 255 }),
  paid_at: timestamp('paid_at'),
  currency: varchar('currency', { length: 10 }).notNull().default('MXN'),
  client_uuid: varchar('client_uuid', { length: 100 }),
});

export const income_records = pgTable('income_records', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  branch_id: bigint('branch_id', { mode: 'bigint' })
    .notNull()
    .references(() => branches.UniqueID),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  payment_id: bigint('payment_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_payments.UniqueID),
  gross_amount: numeric('gross_amount', { precision: 12, scale: 2 }).notNull(),
  commission_amount: numeric('commission_amount', {
    precision: 12,
    scale: 2,
  }).notNull(),
  net_amount: numeric('net_amount', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull().default('MXN'),
  status: incomeRecordStatusEnum('status').notNull().default('pendiente'),
  settled_at: timestamp('settled_at'),
  created_at: timestamp('created_at').notNull().defaultNow(),
  commission_status: commissionStatusEnum('commission_status').notNull().default('pendiente'),
  commission_paid_at: timestamp('commission_paid_at'),
});

export const request_dispatches = pgTable('request_dispatches', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  employee_id: bigint('employee_id', { mode: 'bigint' })
    .notNull()
    .references(() => employees.UniqueID),
  notified_at: timestamp('notified_at').notNull().defaultNow(),
  responded_at: timestamp('responded_at'),
  response: dispatchResponseEnum('response'),
});

export const service_request_events = pgTable('service_request_events', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  from_status: serviceRequestStatusEnum('from_status'),
  to_status: serviceRequestStatusEnum('to_status').notNull(),
  changed_by: bigint('changed_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  created_at: timestamp('created_at').notNull().defaultNow(),
  latitude: numeric('latitude', { precision: 10, scale: 7 }),
  longitude: numeric('longitude', { precision: 10, scale: 7 }),
});

export const commission_settings = pgTable('commission_settings', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  percentage: numeric('percentage', { precision: 5, scale: 2 }).notNull(),
  effective_from: timestamp('effective_from').notNull(),
  created_by: bigint('created_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// MÓDULO: Chat
// ============================================================================

export const conversations = pgTable('conversations', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  status: varchar('status', { length: 50 }).notNull().default('abierta'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

export const request_messages = pgTable('request_messages', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  conversation_id: bigint('conversation_id', { mode: 'bigint' })
    .notNull()
    .references(() => conversations.UniqueID),
  sender_id: bigint('sender_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  message: text('message').notNull(),
  message_reply_id: bigint('message_reply_id', { mode: 'bigint' }).references(
    (): AnyPgColumn => request_messages.UniqueID,
  ),
  client_uuid: varchar('client_uuid', { length: 100 }),
  read_at: timestamp('read_at'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

export const message_attachments = pgTable('message_attachments', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  message_id: bigint('message_id', { mode: 'bigint' })
    .notNull()
    .references(() => request_messages.UniqueID),
  storage_key: varchar('storage_key', { length: 500 }).notNull(),
  mime_type: attachmentMimeTypeEnum('mime_type').notNull(),
  size_bytes: integer('size_bytes'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// MÓDULO: Reseñas y reportes
// ============================================================================

export const reviews = pgTable('reviews', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  request_id: bigint('request_id', { mode: 'bigint' })
    .notNull()
    .references(() => service_requests.UniqueID),
  direction: reviewDirectionEnum('direction').notNull(),
  author_id: bigint('author_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  reviewee_id: bigint('reviewee_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  status: reviewStatusEnum('status').notNull().default('publicada'),
  client_uuid: varchar('client_uuid', { length: 100 }),
});

export const review_attachments = pgTable('review_attachments', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  review_id: bigint('review_id', { mode: 'bigint' })
    .notNull()
    .references(() => reviews.UniqueID),
  storage_key: varchar('storage_key', { length: 500 }).notNull(),
  mime_type: attachmentMimeTypeEnum('mime_type').notNull(),
  size_bytes: integer('size_bytes'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

export const reports = pgTable('reports', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  reporter_id: bigint('reporter_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  request_id: bigint('request_id', { mode: 'bigint' }).references(() => service_requests.UniqueID),
  category: reportCategoryEnum('category').notNull(),
  priority: reportPriorityEnum('priority').notNull().default('media'),
  status: reportStatusEnum('status').notNull().default('pendiente'),
  description: text('description').notNull(),
  assigned_to: bigint('assigned_to', { mode: 'bigint' }).references(() => users.UniqueID),
  resolution_type: reportResolutionTypeEnum('resolution_type'),
  resolution_note: text('resolution_note'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

export const reports_events = pgTable('reports_events', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  report_id: bigint('report_id', { mode: 'bigint' })
    .notNull()
    .references(() => reports.UniqueID),
  author_id: bigint('author_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  type: reportEventTypeEnum('type').notNull(),
  body: text('body').notNull(),
  from_status: reportStatusEnum('from_status'),
  to_status: reportStatusEnum('to_status'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

export const report_attachments = pgTable('report_attachments', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  report_id: bigint('report_id', { mode: 'bigint' })
    .notNull()
    .references(() => reports.UniqueID),
  uploaded_by: bigint('uploaded_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  file_key: varchar('file_key', { length: 500 }).notNull(),
  mime_type: attachmentMimeTypeEnum('mime_type').notNull(),
  size_bytes: integer('size_bytes'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// MÓDULO: Cuentas, roles y accesos (Parte 2: Depende de reports)
// ============================================================================

export const account_sanctions = pgTable('account_sanctions', {
  UniqueID: bigserial('UniqueID', { mode: 'bigint' }).primaryKey(),
  user_id: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  report_id: bigint('report_id', { mode: 'bigint' }).references(() => reports.UniqueID),
  type: sanctionTypeEnum('type').notNull(),
  reason: text('reason').notNull(),
  starts_at: timestamp('starts_at').notNull(),
  ends_at: timestamp('ends_at'),
  active: boolean('active').notNull().default(true),
  created_by: bigint('created_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.UniqueID),
  created_at: timestamp('created_at').notNull().defaultNow(),
});
