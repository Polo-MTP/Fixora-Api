# API-18 — WebSocket autenticado

## Conexión

- URL local: `ws://localhost:3001/ws` (usa el puerto configurado en `PORT`).
- Producción: `wss://<host>/ws` detrás de HTTPS.
- El cliente abre la conexión y debe autenticarse en los primeros 5 segundos.
- El token de acceso no se envía en la URL para evitar que termine en logs o historiales.

Primer mensaje:

```json
{
  "type": "authenticate",
  "token": "<JWT_ACCESS_TOKEN>"
}
```

Respuesta correcta:

```json
{
  "type": "authenticated",
  "user": { "id": "123", "role": "cliente" },
  "rooms": ["users:123"]
}
```

La conexión valida firma, expiración, emisor `fixora-api`, audiencia `fixora-client`, tipo `access`, sesión vigente/no revocada y cuenta activa. La sesión se vuelve a validar al procesar cada mensaje autenticado.

## Salas

Al autenticar, el usuario entra automáticamente a `users:<userId>`.

Para entrar a la sala de una solicitud:

```json
{ "type": "subscribe_request", "requestId": "456" }
```

Solo se permite si el usuario es cliente propietario, técnico asignado/notificado, gerente de la sucursal o proveedor propietario de la sucursal.

Para salir:

```json
{ "type": "unsubscribe_request", "requestId": "456" }
```

## Mensajes de control

```json
{ "type": "ping" }
```

Respuesta: `{ "type": "pong", "timestamp": "..." }`.

Los eventos publicados por `RealTimeObserver` llegan con esta forma:

```json
{
  "type": "event",
  "event": "service_request_updated",
  "channel": "requests:456",
  "data": {
    "requestId": "456",
    "status": "en_camino",
    "previousStatus": "aceptada",
    "latitude": 25.5688,
    "longitude": -103.4957
  },
  "timestamp": "..."
}
```

Al cerrar la conexión se eliminan todas sus suscripciones. Los mensajes de cliente no permiten publicar eventos ni unirse directamente a salas arbitrarias.

## Chat por solicitud (API-35)

El chat usa una sala propia, `chats:<requestId>`, distinta de `requests:<requestId>`. A la sala de la solicitud
pueden entrar técnicos que solo recibieron el aviso; al chat solo entra quien participa: el cliente dueño, el
técnico asignado, el gerente de la sucursal y el proveedor dueño de la sucursal. Existe desde que se acepta la
solicitud.

Los mensajes se **envían por REST** (`POST /api/service-requests/:id/chat/messages`) y se **reciben por el
WebSocket**. Así el reintento con `client_uuid` no duplica y las fotos usan el flujo de subida que ya existe.

Entrar y salir de la sala:

```json
{ "type": "subscribe_chat", "requestId": "456" }
{ "type": "unsubscribe_chat", "requestId": "456" }
```

Respuesta: `{ "type": "subscribed", "room": "chats:456" }`. Si no participa, `FORBIDDEN_ROOM`.

Eventos:

| Evento               | Sala            | Cuándo                                                                 |
| -------------------- | --------------- | ---------------------------------------------------------------------- |
| `chat_message`       | `chats:<id>`    | Hay un mensaje nuevo. `data` es el mensaje completo, igual que en REST. |
| `chat_messages_read` | `chats:<id>`    | La otra parte leyó mensajes: `messageIds`, `readerId`, `readAt`.        |
| `chat_unread`        | `users:<id>`    | Al destinatario, aunque no tenga el chat abierto: contador de no leídos. |

El emisor también recibe su propio `chat_message`; la app lo reconoce por `client_uuid` y no lo duplica.

Tras una desconexión, la app vuelve a entrar a la sala y pide lo que falta con
`GET /api/service-requests/:id/chat?after=<id del último mensaje recibido>`.

### Push cuando la app está en segundo plano

Si el destinatario no tiene ningún socket autenticado y abierto, se le envía un push con
`data = { type: "chat_message", entity_type: "service_request", entity_id: "<requestId>" }`. Si tiene la app
conectada, solo recibe el evento por WebSocket. Para que "conectado" signifique algo, el servidor manda un
ping cada 30 segundos y cierra los sockets que no responden.
