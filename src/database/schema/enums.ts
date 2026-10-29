import { pgEnum } from 'drizzle-orm/pg-core';

// Cuentas, roles y accesos
export const userStateEnum = pgEnum('user_state', [
  'por_verificar',
  'por_aprobar',
  'activo',
  'suspendido',
  'inactivo',
]);

export const devicePlatformEnum = pgEnum('device_platform', ['android', 'ios', 'web']);

export const sanctionTypeEnum = pgEnum('sanction_type', [
  'restriccion_temporal',
  'baja_reputacion',
  'usuario_problematico',
]);

// Personal
export const scheduleBlockReasonEnum = pgEnum('schedule_block_reason', [
  'vacaciones',
  'personal',
  'ocupado',
]);

// Proveedores
export const supplierTypeEnum = pgEnum('supplier_type', ['independiente', 'empresa']);

export const supplierApplicationStateEnum = pgEnum('supplier_application_state', [
  'pendiente',
  'aprobada',
  'rechazada',
]);

export const docSupplierTypeEnum = pgEnum('doc_supplier_type', [
  'independiente',
  'empresa',
  'ambos',
]);

// Servicio
export const serviceRequestStatusEnum = pgEnum('service_request_status', [
  'pendiente',
  'aceptada',
  'agendada',
  'en_curso',
  'completada',
  'cancelada',
  'expirada',
]);

export const canceledByEnum = pgEnum('canceled_by', ['cliente', 'proveedor', 'sistema']);

export const attachmentMimeTypeEnum = pgEnum('attachment_mime_type', [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'other',
]);

export const requestAttachmentKindEnum = pgEnum('request_attachment_kind', [
  'solicitud',
  'evidencia_cancelacion',
  'cierre_servicio',
]);

export const priceAdjustmentReasonEnum = pgEnum('price_adjustment_reason', [
  'materiales_extra',
  'tiempo_adicional',
  'otro',
]);

export const priceAdjustmentStatusEnum = pgEnum('price_adjustment_status', [
  'pendiente',
  'aprobado',
  'rechazado',
  'pagado',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pendiente',
  'completado',
  'fallido',
  'reembolsado',
]);

export const paymentMethodEnum = pgEnum('payment_method', ['tarjeta', 'efectivo', 'transferencia']);

export const incomeRecordStatusEnum = pgEnum('income_record_status', ['pendiente', 'liquidado']);

export const commissionStatusEnum = pgEnum('commission_status', ['pendiente', 'pagada']);

export const dispatchResponseEnum = pgEnum('dispatch_response', ['acepto', 'rechazo', 'expiro']);

// Reseñas y reportes
export const reviewDirectionEnum = pgEnum('review_direction', [
  'cliente_a_proveedor',
  'proveedor_a_cliente',
]);

export const reviewStatusEnum = pgEnum('review_status', ['publicada', 'oculta']);

export const reportCategoryEnum = pgEnum('report_category', [
  'servicio_incompleto',
  'cobro_indebido',
  'danos',
  'conducta_inapropiada',
  'otro',
]);

export const reportPriorityEnum = pgEnum('report_priority', ['baja', 'media', 'alta', 'urgente']);

export const reportStatusEnum = pgEnum('report_status', [
  'pendiente',
  'en_revision',
  'resuelto',
  'rechazado',
]);

export const reportResolutionTypeEnum = pgEnum('report_resolution_type', [
  'sin_sancion',
  'reembolso',
  'sancion_usuario',
  'bloqueo_cuenta',
  'otro',
]);

export const reportEventTypeEnum = pgEnum('report_event_type', [
  'comentario',
  'cambio_estado',
  'asignacion',
  'resolucion',
]);
