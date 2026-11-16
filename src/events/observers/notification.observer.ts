import { and, eq } from 'drizzle-orm';
import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import {
  DOMAIN_EVENTS,
  type ServiceRequestStatusChangedPayload,
  type ServiceRequestDispatchedPayload,
  type ServiceRequestRejectedPayload,
  type SupplierVerificationPayload,
  type SupplierApplicationResolvedPayload,
  type SupplierApplicationCreatedPayload,
} from '../events/domain-events.ts';
import { db } from '../../config/database.ts';
import { notifications, roles, users } from '../../database/schema/tables.ts';
import { fcmService } from '../../services/fcm.service.ts';

export interface NotificationRecord {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export type NotificationPersister = (record: NotificationRecord) => Promise<void>;
export type NotificationPushSender = (record: NotificationRecord) => Promise<void>;
export type AdministratorRecipientProvider = () => Promise<string[]>;

export class NotificationObserver implements Observer<DomainEvent> {
  public readonly name = 'NotificationObserver';
  private readonly persister: NotificationPersister;
  private readonly pushSender: NotificationPushSender;
  private readonly administratorRecipientProvider: AdministratorRecipientProvider;
  private readonly dispatchedRecords: NotificationRecord[] = [];

  constructor(
    customPersister?: NotificationPersister,
    customPushSender?: NotificationPushSender,
    customAdministratorRecipientProvider?: AdministratorRecipientProvider,
  ) {
    this.persister = customPersister ?? this.defaultDatabasePersister;
    this.pushSender = customPushSender ?? this.defaultPushSender;
    this.administratorRecipientProvider =
      customAdministratorRecipientProvider ?? this.defaultAdministratorRecipientProvider;
  }

  private async defaultDatabasePersister(record: NotificationRecord): Promise<void> {
    await db.insert(notifications).values({
      user_id: BigInt(record.userId),
      type: record.type,
      title: record.title,
      message: record.message,
      entity_type: record.entityType,
      entity_id: record.entityId ? BigInt(record.entityId) : null,
    });
  }

  private async defaultPushSender(record: NotificationRecord): Promise<void> {
    const data: Record<string, string> = { type: record.type };
    if (record.entityType) data.entity_type = record.entityType;
    if (record.entityId) data.entity_id = record.entityId;

    await fcmService.sendToUser(record.userId, {
      title: record.title,
      body: record.message,
      data,
    });
  }

  private async defaultAdministratorRecipientProvider(): Promise<string[]> {
    const administrators = await db
      .select({ id: users.UniqueID })
      .from(users)
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(
        and(eq(roles.name, 'administrador'), eq(roles.active, true), eq(users.state, 'activo')),
      );

    return administrators.map((administrator) => administrator.id.toString());
  }

  private async dispatch(record: NotificationRecord): Promise<void> {
    this.dispatchedRecords.push(record);
    // El registro persistente es la fuente de verdad; un fallo de FCM no debe perderlo.
    await this.persister(record);
    try {
      await this.pushSender(record);
    } catch (error) {
      console.error('[NotificationObserver] No fue posible enviar la notificación push:', error);
    }
  }

  public async handle(event: DomainEvent): Promise<void> {
    switch (event.eventType) {
      case DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED:
        await this.handleServiceRequest(event.payload as ServiceRequestStatusChangedPayload);
        break;
      case DOMAIN_EVENTS.SERVICE_REQUEST_DISPATCHED:
        await this.handleServiceRequestDispatched(event.payload as ServiceRequestDispatchedPayload);
        break;
      case DOMAIN_EVENTS.SERVICE_REQUEST_REJECTED:
        await this.handleServiceRequestRejected(event.payload as ServiceRequestRejectedPayload);
        break;
      case DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED:
        await this.handleSupplierVerification(event.payload as SupplierVerificationPayload);
        break;
      case DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED:
        await this.handleSupplierApplicationResolved(
          event.payload as SupplierApplicationResolvedPayload,
        );
        break;
      case DOMAIN_EVENTS.SUPPLIER_APPLICATION_CREATED:
        await this.handleSupplierApplicationCreated(
          event.payload as SupplierApplicationCreatedPayload,
        );
        break;
      default:
        break;
    }
  }

  private async handleServiceRequest(payload: ServiceRequestStatusChangedPayload): Promise<void> {
    const { requestId, fromStatus, toStatus, clientId, reason } = payload;
    // La creación inicial (null -> pendiente) no es un cambio notificable al propio cliente.
    if (fromStatus === null) return;

    let message = `El estado de tu solicitud cambió a "${toStatus}".`;

    if (toStatus === 'aceptada') {
      message = '¡Un profesional ha aceptado tu solicitud de servicio!';
    } else if (toStatus === 'en_curso' || toStatus === 'en_camino') {
      message = 'El técnico está en camino a tu domicilio.';
    } else if (toStatus === 'llegado') {
      message = 'El técnico ha llegado a tu domicilio.';
    } else if (toStatus === 'completada') {
      message = 'Tu servicio ha sido marcado como completado. ¡No olvides calificar la atención!';
    } else if (toStatus === 'cancelada') {
      message = `Tu solicitud fue cancelada${reason ? ': ' + reason : '.'}`;
    } else if (toStatus === 'expirada') {
      message = 'Tu solicitud expiró porque ningún técnico la aceptó dentro de los 5 minutos. Puedes crear una nueva solicitud.';
    }

    await this.dispatch({
      userId: clientId,
      type: `solicitud_${toStatus}`,
      title: `Actualización de Solicitud #${requestId}`,
      message,
      entityType: 'service_request',
      entityId: requestId,
    });
  }

  private async handleServiceRequestRejected(payload: ServiceRequestRejectedPayload): Promise<void> {
    if (payload.isEmergency) return;
    await this.dispatch({
      userId: payload.clientId,
      type: 'solicitud_rechazada_proveedor',
      title: `Respuesta a tu solicitud #${payload.requestId}`,
      message: `El proveedor rechazó la solicitud${payload.reason ? `: ${payload.reason}` : '.'} Puedes elegir otro proveedor.`,
      entityType: 'service_request',
      entityId: payload.requestId,
    });
  }

  private async handleServiceRequestDispatched(
    payload: ServiceRequestDispatchedPayload,
  ): Promise<void> {
    await Promise.all(
      payload.recipientUserIds.map((userId) =>
        this.dispatch({
          userId,
          type: 'solicitud_emergencia_disponible',
          title: 'Nueva solicitud de emergencia cercana',
          message: `Hay una solicitud de emergencia de ${payload.categoryName} a menos de ${payload.radiusKm} km.`,
          entityType: 'service_request',
          entityId: payload.requestId,
        }),
      ),
    );
  }

  private async handleSupplierVerification(payload: SupplierVerificationPayload): Promise<void> {
    const { supplierId, userId, result, comment, documentId, documentName } = payload;

    if (documentId) {
      const name = documentName ?? `#${documentId}`;
      const message =
        result === 'pendiente'
          ? `Recibimos tu documento ${name} y está pendiente de revisión.`
          : result === 'aprobado'
            ? `Tu documento ${name} fue aprobado.${comment ? ` Observación: ${comment}` : ''}`
            : `Tu documento ${name} requiere correcciones.${comment ? ` Motivo: ${comment}` : ''}`;

      await this.dispatch({
        userId,
        type: 'revision_documento_proveedor',
        title: `Revisión de documento: ${name}`,
        message,
        entityType: 'supplier_document',
        entityId: documentId,
      });
      return;
    }

    const message =
      result === 'pendiente'
        ? 'Hemos recibido tu solicitud de proveedor y está pendiente de revisión.'
        : result === 'aprobado'
          ? '¡Felicidades! Tus documentos de proveedor han sido aprobados. Tu cuenta está habilitada.'
          : `Tu verificación de documentos fue rechazada${comment ? ': ' + comment : '.'}`;

    await this.dispatch({
      userId,
      type: 'verificacion_proveedor',
      title:
        result === 'pendiente'
          ? 'Solicitud recibida'
          : result === 'aprobado'
            ? 'Verificación Aprobada'
            : 'Verificación Rechazada',
      message,
      entityType: 'supplier_verification',
      entityId: supplierId,
    });
  }

  private async handleSupplierApplicationResolved(
    payload: SupplierApplicationResolvedPayload,
  ): Promise<void> {
    const labels = {
      aprobada: 'aprobada',
      rechazada: 'rechazada',
      documentacion_incompleta: 'requiere documentación adicional',
    } as const;

    await this.dispatch({
      userId: payload.userId,
      type: 'solicitud_proveedor_resuelta',
      title: 'Resultado de tu solicitud de proveedor',
      message: `Tu solicitud #${payload.applicationId} fue ${labels[payload.state]}.${payload.comments ? ` Observaciones: ${payload.comments}` : ''}`,
      entityType: 'supplier_application',
      entityId: payload.applicationId,
    });
  }

  private async handleSupplierApplicationCreated(
    payload: SupplierApplicationCreatedPayload,
  ): Promise<void> {
    const administratorIds = await this.administratorRecipientProvider();
    const recordBase = {
      type: 'nueva_solicitud_proveedor',
      title: 'Nueva solicitud de proveedor',
      message: `El negocio ${payload.businessName} registró una nueva solicitud de proveedor (#${payload.applicationId}).`,
      entityType: 'supplier_application',
      entityId: payload.applicationId,
    };

    for (const userId of administratorIds) {
      await this.dispatch({ userId, ...recordBase });
    }
  }

  public getDispatchedRecords(): ReadonlyArray<NotificationRecord> {
    return this.dispatchedRecords;
  }

  public clearRecords(): void {
    this.dispatchedRecords.length = 0;
  }
}
