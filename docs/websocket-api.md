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
