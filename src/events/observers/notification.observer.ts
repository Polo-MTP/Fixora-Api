
import { and, eq } from 'drizzle-orm';
import type { Observer } from '../interfaces/observer.interface.ts';
import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import {
  DOMAIN_EVENTS,
  type ServiceRequestStatusChangedPayload,
  type ServiceRequestDispatchedPayload,
  type ServiceRequestRejectedPayload,
  type PriceAdjustmentProposedPayload,
  type PriceAdjustmentRespondedPayload,
  type PaymentRegisteredPayload,
  type PaymentRespondedPayload,
  type DebtReminderPayload,
  type ReportStatusChangedPayload,
  type SupplierVerificationPayload,
  type SupplierApplicationResolvedPayload,
  type SupplierApplicationCreatedPayload,
  type ChatMessageSentPayload,
} from '../events/domain-events.ts';
import { db } from '../../config/database.ts';
import {
  branches,
  business_supplier,
  employees,
  notifications,
  roles,
  suppliers,
  users,
} from '../../database/schema/tables.ts';
import { fcmService } from '../../services/fcm.service.ts';
import { hasActiveConnection } from '../../realtime/websocket.server.ts';

export interface NotificationRecord {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  /** Aviso de solicitud entrante al técnico: se manda como alarma (API-28). */
  alarm?: boolean;
}

/** Quién del lado del proveedor recibe una solicitud nueva: el técnico asignado o la sucursal. */
export type ProviderRecipientProvider = (target: {
  employeeId: string | null;
  branchId: string;
}) => Promise<string[]>;

export type NotificationPersister = (record: NotificationRecord) => Promise<void>;
export type NotificationPushSender = (record: NotificationRecord) => Promise<void>;
export type AdministratorRecipientProvider = () => Promise<string[]>;
/** Indica si el usuario tiene la app conectada en este momento (WebSocket abierto). */
export type PresenceChecker = (userId: string) => Promise<boolean> | boolean;

const MAX_RETAINED_RECORDS = 500;

export class NotificationObserver implements Observer<DomainEvent> {
  public readonly name = 'NotificationObserver';

  private readonly persister: NotificationPersister;
  private readonly pushSender: NotificationPushSender;
  private readonly administratorRecipientProvider: AdministratorRecipientProvider;
  private readonly presenceChecker: PresenceChecker;
  private readonly providerRecipientProvider: ProviderRecipientProvider;

  private readonly dispatchedRecords: NotificationRecord[] = [];

  constructor(
    customPersister?: NotificationPersister,
    customPushSender?: NotificationPushSender,
    customAdministratorRecipientProvider?: AdministratorRecipientProvider,
    customPresenceChecker?: PresenceChecker,
    customProviderRecipientProvider?: ProviderRecipientProvider,
  ) {
    this.persister = customPersister ?? this.defaultDatabasePersister;
    this.pushSender = customPushSender ?? this.defaultPushSender;

    this.administratorRecipientProvider =
      customAdministratorRecipientProvider ?? this.defaultAdministratorRecipientProvider;

    this.presenceChecker = customPresenceChecker ?? hasActiveConnection;

    this.providerRecipientProvider =
      customProviderRecipientProvider ?? this.defaultProviderRecipientProvider;
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

    if (record.alarm) {
      await fcmService.sendIncomingRequestAlarm(record.userId, {
        title: record.title,
        body: record.message,
        data,
      });

      return;
    }

    await fcmService.sendToUser(record.userId, {
      title: record.title,
      body: record.message,
      data,
    });
  }

  /**
   * Técnico asignado (si la solicitud ya trae uno) o, si no, el personal activo de la sucursal y
   * el dueño del negocio: el que tenga la app abierta primero la atiende.
   */
  private async defaultProviderRecipientProvider(target: {
    employeeId: string | null;
    branchId: string;
  }): Promise<string[]> {
    if (target.employeeId) {
      const [employee] = await db
        .select({ userId: employees.user_id })
        .from(employees)
        .where(
          and(
            eq(employees.UniqueID, BigInt(target.employeeId)),
            eq(employees.active, true),
          ),
        )
        .limit(1);

      if (employee) return [employee.userId.toString()];
    }

    const branchId = BigInt(target.branchId);

    const staff = await db
      .select({ userId: employees.user_id })
      .from(employees)
      .where(
        and(
          eq(employees.branch_id, branchId),
          eq(employees.active, true),
        ),
      );

    const owners = await db
      .select({ userId: suppliers.user_id })
      .from(branches)
      .innerJoin(
        business_supplier,
        eq(branches.business_id, business_supplier.business_id),
      )
      .innerJoin(
        suppliers,
        eq(business_supplier.supplier_id, suppliers.UniqueID),
      )
      .where(
        and(
          eq(branches.UniqueID, branchId),
          eq(business_supplier.active, true),
          eq(suppliers.active, true),
        ),
      );

    return Array.from(
      new Set([...staff, ...owners].map((row) => row.userId.toString())),
    );
  }

  private async defaultAdministratorRecipientProvider(): Promise<string[]> {
    const administrators = await db
      .select({ id: users.UniqueID })
      .from(users)
      .innerJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(
        and(
          eq(roles.name, 'administrador'),
          eq(roles.active, true),
          eq(users.state, 'activo'),
        ),
      );

    return administrators.map((administrator) => administrator.id.toString());
  }

  private remember(record: NotificationRecord): void {
    // Solo para pruebas; se acota para no crecer sin límite en producción.
    this.dispatchedRecords.push(record);

    if (this.dispatchedRecords.length > MAX_RETAINED_RECORDS) {
      this.dispatchedRecords.shift();
    }
  }

  private async dispatch(record: NotificationRecord): Promise<void> {
    this.remember(record);

    // El registro persistente es la fuente de verdad; un fallo de FCM no debe perderlo.
    await this.persister(record);

    try {
      await this.pushSender(record);
    } catch (error) {
      console.error(
        '[NotificationObserver] No fue posible enviar la notificación push:',
        error,
      );
    }
  }

  public async handle(event: DomainEvent): Promise<void> {
    switch (event.eventType) {
      case DOMAIN_EVENTS.SERVICE_REQUEST_STATUS_CHANGED:
        await this.handleServiceRequest(
          event.payload as ServiceRequestStatusChangedPayload,
        );
        break;

      case DOMAIN_EVENTS.SERVICE_REQUEST_DISPATCHED:
        await this.handleServiceRequestDispatched(
          event.payload as ServiceRequestDispatchedPayload,
        );
        break;

      case DOMAIN_EVENTS.SERVICE_REQUEST_REJECTED:
        await this.handleServiceRequestRejected(
          event.payload as ServiceRequestRejectedPayload,
        );
        break;

      case DOMAIN_EVENTS.PRICE_ADJUSTMENT_PROPOSED:
        await this.handlePriceAdjustmentProposed(
          event.payload as PriceAdjustmentProposedPayload,
        );
        break;

      case DOMAIN_EVENTS.PRICE_ADJUSTMENT_RESPONDED:
        await this.handlePriceAdjustmentResponded(
          event.payload as PriceAdjustmentRespondedPayload,
        );
        break;

      case DOMAIN_EVENTS.PAYMENT_REGISTERED:
        await this.handlePaymentRegistered(
          event.payload as PaymentRegisteredPayload,
        );
        break;

      case DOMAIN_EVENTS.PAYMENT_RESPONDED:
        await this.handlePaymentResponded(
          event.payload as PaymentRespondedPayload,
        );
        break;

      case DOMAIN_EVENTS.DEBT_REMINDER:
        await this.handleDebtReminder(
          event.payload as DebtReminderPayload,
        );
        break;

      case DOMAIN_EVENTS.REPORT_STATUS_CHANGED:
        await this.handleReport(
          event.payload as ReportStatusChangedPayload,
        );
        break;

      case DOMAIN_EVENTS.SUPPLIER_VERIFICATION_CHANGED:
        await this.handleSupplierVerification(
          event.payload as SupplierVerificationPayload,
        );
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

      case DOMAIN_EVENTS.CHAT_MESSAGE_SENT:
        await this.handleChatMessage(
          event.payload as ChatMessageSentPayload,
        );
        break;

      default:
        break;
    }
  }

  private async handleServiceRequest(
    payload: ServiceRequestStatusChangedPayload,
  ): Promise<void> {
    const { requestId, fromStatus, toStatus, clientId, reason } = payload;

    // La creación inicial (null -> pendiente) no se le notifica al propio cliente;
    // a quien se le avisa es al proveedor, como alarma (API-28).
    // La de emergencia avisa en el despacho.
    if (fromStatus === null) {
      if (toStatus === 'pendiente' && payload.branchId) {
        await this.notifyIncomingRequest(
          requestId,
          payload.employeeId ?? null,
          payload.branchId,
        );
      }

      return;
    }

    let message = `El estado de tu solicitud cambió a "${toStatus}".`;

    if (toStatus === 'aceptada') {
      message = '¡Un profesional ha aceptado tu solicitud de servicio!';
    } else if (toStatus === 'en_curso') {
      // Compatibilidad con el estado histórico utilizado por módulos anteriores.
      message = 'El técnico está en camino o atendiendo tu solicitud.';
    } else if (toStatus === 'en_camino') {
      message = 'El técnico está en camino a tu domicilio.';
    } else if (toStatus === 'llegado') {
      message = 'El técnico ha llegado a tu domicilio.';
    } else if (toStatus === 'completada') {
      message =
        'Tu servicio ha sido marcado como completado. ¡No olvides calificar la atención!';
    } else if (toStatus === 'cancelada') {
      message = `Tu solicitud fue cancelada${reason ? ': ' + reason : '.'}`;
    } else if (toStatus === 'expirada') {
      message =
        'Tu solicitud expiró porque ningún técnico la aceptó dentro de los 5 minutos. Puedes crear una nueva solicitud.';
    }

    const title =
      toStatus === 'llegado'
        ? '¡Tu técnico ha llegado!'
        : `Actualización de Solicitud #${requestId}`;

    await this.dispatch({
      userId: clientId,
      type: `solicitud_${toStatus}`,
      title,
      message,
      entityType: 'service_request',
      entityId: requestId,
    });
  }

  private async notifyIncomingRequest(
    requestId: string,
    employeeId: string | null,
    branchId: string,
  ): Promise<void> {
    const recipients = await this.providerRecipientProvider({
      employeeId,
      branchId,
    });

    await Promise.all(
      recipients.map((userId) =>
        this.dispatch({
          userId,
          type: 'nueva_solicitud',
          title: 'Nueva solicitud de servicio',
          message: `Un cliente te envió la solicitud #${requestId}. Revísala y responde a tiempo.`,
          entityType: 'service_request',
          entityId: requestId,
          alarm: true,
        }),
      ),
    );
  }

  private async handleServiceRequestRejected(
    payload: ServiceRequestRejectedPayload,
  ): Promise<void> {
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

  /** El cliente debe aprobar o rechazar lo que el técnico quiere cobrar de más (API-36). */
  private async handlePriceAdjustmentProposed(
    payload: PriceAdjustmentProposedPayload,
  ): Promise<void> {
    const detail = payload.description ? `: ${payload.description}` : '.';

    await this.dispatch({
      userId: payload.clientId,
      type: 'ajuste_precio_propuesto',
      title: 'El técnico propone un ajuste de precio',
      message: `Se agregarían $${payload.amount} a tu servicio #${payload.requestId}${detail} Apruébalo o recházalo.`,
      entityType: 'service_request',
      entityId: payload.requestId,
    });
  }

  private async handlePriceAdjustmentResponded(
    payload: PriceAdjustmentRespondedPayload,
  ): Promise<void> {
    const approved = payload.decision === 'aprobado';

    await Promise.all(
      payload.technicianUserIds.map((userId) =>
        this.dispatch({
          userId,
          type: approved
            ? 'ajuste_precio_aprobado'
            : 'ajuste_precio_rechazado',
          title: approved
            ? 'El cliente aprobó el ajuste'
            : 'El cliente rechazó el ajuste',
          message: `El ajuste de $${payload.amount} de la solicitud #${payload.requestId} fue ${payload.decision}.`,
          entityType: 'service_request',
          entityId: payload.requestId,
        }),
      ),
    );
  }

  /** El proveedor debe confirmar que recibió el pago (API-37). */
  private async handlePaymentRegistered(
    payload: PaymentRegisteredPayload,
  ): Promise<void> {
    const method =
      payload.method === 'transferencia'
        ? 'por transferencia'
        : 'en efectivo';

    await Promise.all(
      payload.providerUserIds.map((userId) =>
        this.dispatch({
          userId,
          type: 'pago_registrado',
          title: 'Confirma el pago del cliente',
          message: `El cliente registró un pago de $${payload.amount} ${method} por la solicitud #${payload.requestId}. Confirma si lo recibiste.`,
          entityType: 'service_request',
          entityId: payload.requestId,
        }),
      ),
    );
  }

  private async handlePaymentResponded(
    payload: PaymentRespondedPayload,
  ): Promise<void> {
    const confirmed = payload.decision === 'completado';
    const pending = payload.balanceDue !== '0.00';

    let message: string;

    if (confirmed) {
      message = pending
        ? `El proveedor confirmó tu pago de $${payload.amount}. Aún quedan $${payload.balanceDue} por pagar.`
        : `El proveedor confirmó tu pago de $${payload.amount}. Tu servicio #${payload.requestId} quedó pagado.`;
    } else {
      message = `El proveedor no recibió tu pago de $${payload.amount}${payload.reason ? `: ${payload.reason}` : '.'} Revisa el pago y regístralo de nuevo.`;
    }

    await this.dispatch({
      userId: payload.clientId,
      type: confirmed ? 'pago_confirmado' : 'pago_rechazado',
      title: confirmed
        ? 'Pago confirmado'
        : 'El proveedor no recibió tu pago',
      message,
      entityType: 'service_request',
      entityId: payload.requestId,
    });
  }

  private async handleDebtReminder(
    payload: DebtReminderPayload,
  ): Promise<void> {
    await this.dispatch({
      userId: payload.clientId,
      type: 'recordatorio_adeudo',
      title: 'Tienes un pago pendiente',
      message: `Tu servicio #${payload.requestId} tiene $${payload.balanceDue} por pagar. Registra el pago cuando lo hagas.`,
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
          alarm: true,
        }),
      ),
    );
  }

  private async handleReport(
    payload: ReportStatusChangedPayload,
  ): Promise<void> {
    const { reportId, reporterId, toStatus, resolutionType } = payload;

    let message = `Tu reporte #${reportId} ha cambiado de estado a "${toStatus}".`;

    if (toStatus === 'resuelto') {
      message = `Tu reporte #${reportId} ha sido resuelto${resolutionType ? ' (' + resolutionType + ')' : ''}.`;
    }

    const record: NotificationRecord = {
      userId: reporterId,
      type: 'reporte',
      title: `Actualización de Reporte #${reportId}`,
      message,
      entityType: 'report',
      entityId: reportId,
    };

    this.dispatchedRecords.push(record);
    await this.persister(record);
  }

  private async handleSupplierVerification(
    payload: SupplierVerificationPayload,
  ): Promise<void> {
    const {
      supplierId,
      userId,
      result,
      comment,
      documentId,
      documentName,
    } = payload;

    if (documentId) {
      const name = documentName ?? `#${documentId}`;

      const message =
        result === 'pendiente'
          ? `Recibimos tu documento ${name} y está pendiente de revisión.`
          : result === 'aprobado'
            ? `Tu documento ${name} fue aprobado. Los documentos aprobados de tu solicitud quedan registrados en tu expediente.${comment ? ` Observación: ${comment}` : ''}`
            : `Tu documento ${name} requiere correcciones.${comment ? ` Motivo: ${comment}` : ''}`;

      await this.dispatch({
        userId,
        type: 'revision_documento_proveedor',
        title:
          result === 'aprobado'
            ? 'Verificación Aprobada'
            : `Revisión de documento: ${name}`,
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
    const administratorIds =
      await this.administratorRecipientProvider();

    const recordBase = {
      type: 'nueva_solicitud_proveedor',
      title: 'Nueva solicitud de proveedor',
      message: `El negocio ${payload.businessName} registró una nueva solicitud de proveedor (#${payload.applicationId}).`,
      entityType: 'supplier_application',
      entityId: payload.applicationId,
    };

    for (const userId of administratorIds) {
      await this.dispatch({
        userId,
        ...recordBase,
      });
    }
  }

  /**
   * Push de un mensaje del chat (API-35). Solo se envía si el destinatario no tiene la app
   * conectada: con la app abierta ya lo recibe por WebSocket. No se guarda en el centro de
   * notificaciones para no llenarlo con un registro por mensaje.
   */
  private async handleChatMessage(
    payload: ChatMessageSentPayload,
  ): Promise<void> {
    for (const userId of payload.recipientUserIds) {
      try {
        if (await this.presenceChecker(userId)) continue;

        const record: NotificationRecord = {
          userId,
          type: 'chat_message',
          title: `Mensaje de ${payload.senderName}`,
          message: payload.preview,
          entityType: 'service_request',
          entityId: payload.requestId,
        };

        this.remember(record);
        await this.pushSender(record);
      } catch (error) {
        console.error(
          '[NotificationObserver] No fue posible enviar el push del chat:',
          error,
        );
      }
    }
  }

  public getDispatchedRecords(): ReadonlyArray<NotificationRecord> {
    return this.dispatchedRecords;
  }

  public clearRecords(): void {
    this.dispatchedRecords.length = 0;
  }
}
