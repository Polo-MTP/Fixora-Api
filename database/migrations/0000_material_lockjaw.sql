CREATE TYPE "public"."attachment_mime_type" AS ENUM('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'other');--> statement-breakpoint
CREATE TYPE "public"."canceled_by" AS ENUM('cliente', 'proveedor', 'sistema');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('pendiente', 'pagada');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('android', 'ios', 'web');--> statement-breakpoint
CREATE TYPE "public"."dispatch_response" AS ENUM('acepto', 'rechazo', 'expiro');--> statement-breakpoint
CREATE TYPE "public"."doc_supplier_type" AS ENUM('independiente', 'empresa', 'ambos');--> statement-breakpoint
CREATE TYPE "public"."income_record_status" AS ENUM('pendiente', 'liquidado');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('tarjeta', 'efectivo', 'transferencia');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pendiente', 'completado', 'fallido', 'reembolsado');--> statement-breakpoint
CREATE TYPE "public"."price_adjustment_reason" AS ENUM('materiales_extra', 'tiempo_adicional', 'otro');--> statement-breakpoint
CREATE TYPE "public"."price_adjustment_status" AS ENUM('pendiente', 'aprobado', 'rechazado', 'pagado');--> statement-breakpoint
CREATE TYPE "public"."report_category" AS ENUM('servicio_incompleto', 'cobro_indebido', 'danos', 'conducta_inapropiada', 'otro');--> statement-breakpoint
CREATE TYPE "public"."report_event_type" AS ENUM('comentario', 'cambio_estado', 'asignacion', 'resolucion');--> statement-breakpoint
CREATE TYPE "public"."report_priority" AS ENUM('baja', 'media', 'alta', 'urgente');--> statement-breakpoint
CREATE TYPE "public"."report_resolution_type" AS ENUM('sin_sancion', 'reembolso', 'sancion_usuario', 'bloqueo_cuenta', 'otro');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pendiente', 'en_revision', 'resuelto', 'rechazado');--> statement-breakpoint
CREATE TYPE "public"."request_attachment_kind" AS ENUM('solicitud', 'evidencia_cancelacion', 'cierre_servicio');--> statement-breakpoint
CREATE TYPE "public"."review_direction" AS ENUM('cliente_a_proveedor', 'proveedor_a_cliente');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('publicada', 'oculta');--> statement-breakpoint
CREATE TYPE "public"."sanction_type" AS ENUM('restriccion_temporal', 'baja_reputacion', 'usuario_problematico');--> statement-breakpoint
CREATE TYPE "public"."schedule_block_reason" AS ENUM('vacaciones', 'personal', 'ocupado');--> statement-breakpoint
CREATE TYPE "public"."service_request_status" AS ENUM('pendiente', 'aceptada', 'agendada', 'en_curso', 'completada', 'cancelada', 'expirada');--> statement-breakpoint
CREATE TYPE "public"."supplier_application_state" AS ENUM('pendiente', 'aprobada', 'rechazada');--> statement-breakpoint
CREATE TYPE "public"."supplier_type" AS ENUM('independiente', 'empresa');--> statement-breakpoint
CREATE TYPE "public"."user_state" AS ENUM('por_verificar', 'por_aprobar', 'activo', 'suspendido', 'inactivo');--> statement-breakpoint
CREATE TABLE "account_sanctions" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"report_id" bigint,
	"type" "sanction_type" NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "address_user" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"address_id" bigint NOT NULL,
	"alias" varchar(100),
	"is_main" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"reference" varchar(255),
	"street" varchar(255) NOT NULL,
	"num_ext" varchar(50) NOT NULL,
	"num_int" varchar(50),
	"colony" varchar(150) NOT NULL,
	"municipality" varchar(150) NOT NULL,
	"state" varchar(150) NOT NULL,
	"postal_code" varchar(20) NOT NULL,
	"country" varchar(100) DEFAULT 'México' NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch_schedules" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"branch_id" bigint NOT NULL,
	"day_of_week" integer NOT NULL,
	"open_time" time NOT NULL,
	"close_time" time NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"business_id" bigint NOT NULL,
	"address_id" bigint NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone" varchar(30),
	"timezone" varchar(100) DEFAULT 'America/Mexico_City' NOT NULL,
	"total_jobs" bigint DEFAULT 0 NOT NULL,
	"accepting_request" boolean DEFAULT true NOT NULL,
	"description" text,
	"logo_key" varchar(500),
	"email" varchar(255),
	"rating_avg" numeric(3, 2) DEFAULT '0.00',
	"reviews_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches_categories" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"category_id" bigint NOT NULL,
	"branch_id" bigint NOT NULL,
	"base_price" numeric(12, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"tax_identification" varchar(50),
	"email" varchar(255),
	"phone" varchar(30),
	CONSTRAINT "business_tax_identification_unique" UNIQUE("tax_identification")
);
--> statement-breakpoint
CREATE TABLE "business_supplier" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"business_id" bigint NOT NULL,
	"supplier_id" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(150) NOT NULL,
	"slug" varchar(150) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"icon_key" varchar(500),
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "commission_settings" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"percentage" numeric(5, 2) NOT NULL,
	"effective_from" timestamp NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"status" varchar(50) DEFAULT 'abierta' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"token" varchar(500) NOT NULL,
	"platform" "device_platform" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_validations" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"document_id" bigint NOT NULL,
	"result" varchar(50) NOT NULL,
	"reviewed_by" bigint NOT NULL,
	"comment" text,
	"reviewed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_profiles" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"employee_id" bigint NOT NULL,
	"photo_key" varchar(500),
	"photo_document_id" bigint,
	"bio" text
);
--> statement-breakpoint
CREATE TABLE "employee_vehicles" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"employee_id" bigint NOT NULL,
	"plate" varchar(50) NOT NULL,
	"brand" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"color" varchar(50) NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"branch_id" bigint NOT NULL,
	"can_attend" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "income_records" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"branch_id" bigint NOT NULL,
	"request_id" bigint NOT NULL,
	"payment_id" bigint NOT NULL,
	"gross_amount" numeric(12, 2) NOT NULL,
	"commission_amount" numeric(12, 2) NOT NULL,
	"net_amount" numeric(12, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'MXN' NOT NULL,
	"status" "income_record_status" DEFAULT 'pendiente' NOT NULL,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"commission_status" "commission_status" DEFAULT 'pendiente' NOT NULL,
	"commission_paid_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"mime_type" "attachment_mime_type" NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"type" varchar(100) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"entity_type" varchar(100),
	"entity_id" bigint,
	"read_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "personal_data" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"name" varchar(100) NOT NULL,
	"lastname_p" varchar(100) NOT NULL,
	"lastname_m" varchar(100),
	"birth_date" date,
	"phone" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "portfolio_media" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"work_id" bigint NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "portfolio_works" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"branch_id" bigint NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "price_adjustment" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" "price_adjustment_reason" NOT NULL,
	"status" "price_adjustment_status" DEFAULT 'pendiente' NOT NULL,
	"declared_by" bigint NOT NULL,
	"paid_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "report_attachments" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"report_id" bigint NOT NULL,
	"uploaded_by" bigint NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"mime_type" "attachment_mime_type" NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"reporter_id" bigint NOT NULL,
	"request_id" bigint,
	"category" "report_category" NOT NULL,
	"priority" "report_priority" DEFAULT 'media' NOT NULL,
	"status" "report_status" DEFAULT 'pendiente' NOT NULL,
	"description" text NOT NULL,
	"assigned_to" bigint,
	"resolution_type" "report_resolution_type",
	"resolution_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports_events" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"report_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"type" "report_event_type" NOT NULL,
	"body" text NOT NULL,
	"from_status" "report_status",
	"to_status" "report_status",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_attachments" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"mime_type" "attachment_mime_type" NOT NULL,
	"size_bytes" integer,
	"caption" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"kind" "request_attachment_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_dispatches" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"employee_id" bigint NOT NULL,
	"notified_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"response" "dispatch_response"
);
--> statement-breakpoint
CREATE TABLE "request_messages" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" bigint NOT NULL,
	"sender_id" bigint NOT NULL,
	"message" text NOT NULL,
	"message_reply_id" bigint,
	"client_uuid" varchar(100),
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_attachments" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"review_id" bigint NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"mime_type" "attachment_mime_type" NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"direction" "review_direction" NOT NULL,
	"author_id" bigint NOT NULL,
	"reviewee_id" bigint NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"status" "review_status" DEFAULT 'publicada' NOT NULL,
	"client_uuid" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"employee_id" bigint NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"reason" "schedule_block_reason" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_payments" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" "payment_status" DEFAULT 'pendiente' NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" varchar(255),
	"paid_at" timestamp,
	"currency" varchar(10) DEFAULT 'MXN' NOT NULL,
	"client_uuid" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "service_request_events" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"from_status" "service_request_status",
	"to_status" "service_request_status" NOT NULL,
	"changed_by" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7)
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"client_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"branch_id" bigint NOT NULL,
	"address_id" bigint NOT NULL,
	"employee_id" bigint,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"status" "service_request_status" DEFAULT 'pendiente' NOT NULL,
	"expires_at" timestamp,
	"canceled_by" "canceled_by",
	"canceled_reason" text,
	"agreed_price" numeric(12, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"scheduled_at" timestamp,
	"scheduled_end" timestamp,
	"completed_at" timestamp,
	"total_amount" numeric(12, 2),
	"client_uuid" varchar(100),
	"accepted_at" timestamp,
	"arrived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "supplier_applications" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"reviewed_by" bigint,
	"supplier_id" bigint NOT NULL,
	"supplier_type" "supplier_type" NOT NULL,
	"state" "supplier_application_state" DEFAULT 'pendiente' NOT NULL,
	"comments" text,
	"application_date" date NOT NULL,
	"due_date" date
);
--> statement-breakpoint
CREATE TABLE "supplier_documents" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"supplier_id" bigint NOT NULL,
	"type_document_id" bigint NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"file_hash" varchar(128),
	"upload_date" date NOT NULL,
	"due_date" date,
	"is_public" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"supplier_type" "supplier_type" NOT NULL,
	"rfc" varchar(50),
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "suppliers_rfc_unique" UNIQUE("rfc")
);
--> statement-breakpoint
CREATE TABLE "type_documents" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"requires_expiration_date" boolean DEFAULT false NOT NULL,
	"supplier_type" "doc_supplier_type" DEFAULT 'ambos' NOT NULL,
	"mandatory" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"UniqueID" bigserial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role_id" bigint,
	"state" "user_state" DEFAULT 'por_verificar' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account_sanctions" ADD CONSTRAINT "account_sanctions_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sanctions" ADD CONSTRAINT "account_sanctions_report_id_reports_UniqueID_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sanctions" ADD CONSTRAINT "account_sanctions_created_by_users_UniqueID_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_user" ADD CONSTRAINT "address_user_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_user" ADD CONSTRAINT "address_user_address_id_addresses_UniqueID_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_schedules" ADD CONSTRAINT "branch_schedules_branch_id_branches_UniqueID_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_business_id_business_UniqueID_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_address_id_addresses_UniqueID_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches_categories" ADD CONSTRAINT "branches_categories_category_id_categories_UniqueID_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches_categories" ADD CONSTRAINT "branches_categories_branch_id_branches_UniqueID_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_supplier" ADD CONSTRAINT "business_supplier_business_id_business_UniqueID_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_supplier" ADD CONSTRAINT "business_supplier_supplier_id_suppliers_UniqueID_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settings" ADD CONSTRAINT "commission_settings_created_by_users_UniqueID_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validations" ADD CONSTRAINT "document_validations_document_id_supplier_documents_UniqueID_fk" FOREIGN KEY ("document_id") REFERENCES "public"."supplier_documents"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validations" ADD CONSTRAINT "document_validations_reviewed_by_users_UniqueID_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_employee_id_employees_UniqueID_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_photo_document_id_supplier_documents_UniqueID_fk" FOREIGN KEY ("photo_document_id") REFERENCES "public"."supplier_documents"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vehicles" ADD CONSTRAINT "employee_vehicles_employee_id_employees_UniqueID_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_branches_UniqueID_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_branch_id_branches_UniqueID_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_payment_id_service_payments_UniqueID_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."service_payments"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_request_messages_UniqueID_fk" FOREIGN KEY ("message_id") REFERENCES "public"."request_messages"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data" ADD CONSTRAINT "personal_data_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_media" ADD CONSTRAINT "portfolio_media_work_id_portfolio_works_UniqueID_fk" FOREIGN KEY ("work_id") REFERENCES "public"."portfolio_works"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_works" ADD CONSTRAINT "portfolio_works_branch_id_branches_UniqueID_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_adjustment" ADD CONSTRAINT "price_adjustment_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_adjustment" ADD CONSTRAINT "price_adjustment_declared_by_users_UniqueID_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_attachments" ADD CONSTRAINT "report_attachments_report_id_reports_UniqueID_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_attachments" ADD CONSTRAINT "report_attachments_uploaded_by_users_UniqueID_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_UniqueID_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_users_UniqueID_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports_events" ADD CONSTRAINT "reports_events_report_id_reports_UniqueID_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports_events" ADD CONSTRAINT "reports_events_author_id_users_UniqueID_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_dispatches" ADD CONSTRAINT "request_dispatches_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_dispatches" ADD CONSTRAINT "request_dispatches_employee_id_employees_UniqueID_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_conversation_id_conversations_UniqueID_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_sender_id_users_UniqueID_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_message_reply_id_request_messages_UniqueID_fk" FOREIGN KEY ("message_reply_id") REFERENCES "public"."request_messages"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_attachments" ADD CONSTRAINT "review_attachments_review_id_reviews_UniqueID_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_users_UniqueID_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewee_id_users_UniqueID_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_employee_id_employees_UniqueID_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_payments" ADD CONSTRAINT "service_payments_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request_events" ADD CONSTRAINT "service_request_events_request_id_service_requests_UniqueID_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request_events" ADD CONSTRAINT "service_request_events_changed_by_users_UniqueID_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_client_id_users_UniqueID_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_category_id_categories_UniqueID_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_branch_id_branches_UniqueID_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_address_id_addresses_UniqueID_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_employee_id_employees_UniqueID_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_applications" ADD CONSTRAINT "supplier_applications_reviewed_by_users_UniqueID_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_applications" ADD CONSTRAINT "supplier_applications_supplier_id_suppliers_UniqueID_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_supplier_id_suppliers_UniqueID_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_type_document_id_type_documents_UniqueID_fk" FOREIGN KEY ("type_document_id") REFERENCES "public"."type_documents"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_user_id_users_UniqueID_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("UniqueID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_UniqueID_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("UniqueID") ON DELETE no action ON UPDATE no action;