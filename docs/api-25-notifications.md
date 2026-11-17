# API-25 · Observadores de notificación y centro de notificaciones

## Migración

Antes de probar el centro de notificaciones, aplicar la migración que agrega `created_at` e índices:

```powershell
$dbUser = docker exec fixora-postgres printenv POSTGRES_USER
$dbName = docker exec fixora-postgres printenv POSTGRES_DB
Get-Content ".\database\migrations\0006_api25_notifications_created_at.sql" | docker exec -i fixora-postgres psql -U $dbUser -d $dbName
```

## Endpoints

Todas las rutas requieren `Authorization: Bearer <accessToken>`.

- `GET /api/me/notifications?unread=true&page=1&limit=20`
- `POST /api/me/notifications/{id}/read`
- `POST /api/me/notifications/read-all`

`unread` acepta `true` o `false`; `page` debe ser entero positivo y `limit` debe estar entre 1 y 100. La respuesta del listado incluye `unread_count` para todas las notificaciones no leídas del usuario, aunque se filtre la página por `unread`.

## Eventos de este sprint

- `supplier.application_created`: crea una notificación para cada cuenta activa con rol `administrador`.
- `supplier.verification_changed`: crea una notificación para el proveedor o para el documento revisado.
- `supplier.application_resolved`: crea una notificación con el resultado final al solicitante.
- `service_request.status_changed`: crea una notificación para el cliente cuando cambia de un estado previo a uno nuevo. La emisión inicial `null -> pendiente` no genera notificación al propio cliente.

Cada notificación se persiste primero en `notifications` y después se intenta enviar por Firebase Cloud Messaging a los dispositivos activos del usuario. Un fallo de FCM no elimina el registro persistido.

No se incluye el aviso de solicitud entrante al proveedor, ni eventos de chat, pagos o reportes.

## Push

El envío real requiere configurar `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`, y que el usuario tenga un token de dispositivo activo registrado mediante `/api/me/devices`. Sin credenciales Firebase, el servicio FCM conserva su modo simulado existente.
