# Documentación Técnica de Fixora API

Fixora API es el backend central de la plataforma **Fixora**, un sistema integral para la contratación, gestión y seguimiento en tiempo real de servicios técnicos a domicilio y reparaciones.

---

## 1. Visión General de la Arquitectura

### 1.1 Stack Tecnológico
- **Entorno y Lenguaje:** Node.js v20+ con TypeScript (`tsx` para ejecución y `tsc` para compilación).
- **Framework Web:** Express v5 (`express@^5.2.1`).
- **Base de Datos Relacional:** PostgreSQL gestionado a través de **Drizzle ORM** (`drizzle-orm@^0.45.4`).
- **Caché y Tiempo Real:** **Redis** (`redis@^5.12.1`) para temporizadores de solicitudes (TTL 5 min), almacenamiento geoespacial (GEOINDEX de técnicos) y control de presencia/disponibilidad.
- **WebSockets:** `ws@^8.18.3` montado en `/ws` para sincronización bidireccional de eventos y salas reactivas.
- **Notificaciones Push:** Firebase Cloud Messaging (**FCM**) a través de `firebase-admin@^14.5.0`.
- **Servicio de Correos Transaccionales:** **Resend** (`resend@^6.37.0`) para códigos de verificación OTP y recuperación de cuentas.
- **Almacenamiento de Archivos:** Sistema local con enlaces firmados temporalmente vía **HMAC SHA-256** y control por roles/propietario.
- **Validación de Datos:** Esquemas tipados con **Zod** y validaciones manuales desacopladas.
- **Contenedores:** Docker Compose para Redis local (`redis-data` en `127.0.0.1:6379`).

### 1.2 Patrones de Diseño
1. **Patrón Observer (Event-Driven Domain Architecture):**
   - Implementado en `src/events/`. Desacopla la lógica de negocio de los efectos secundarios.
   - Observadores activos:
     - `EmailObserver`: Despacha correos automáticos ante eventos de negocio.
     - `RealTimeObserver`: Publica eventos a través de WebSocket y actualiza canales Redis.
     - `NotificationObserver`: Persiste notificaciones en base de datos y envía notificaciones push móviles vía Firebase Cloud Messaging (FCM).
     - `HistoryObserver`: Registra la bitácora histórica inmutable de estados (`service_request_events`).
2. **Capas Desacopladas (Layered Architecture):**
   - **Rutas (`src/routes/`):** Enrutamiento y asociación de middlewares (autenticación, autorización de roles, carga de archivos).
   - **Controladores (`src/controllers/`):** Desempaquetado de petición HTTP, sanitización preliminar y formateo de respuesta.
   - **Servicios (`src/services/`):** Lógica pura de negocio, reglas de dominio y transacciones atómicas de base de datos.
   - **Acceso a Datos / Esquemas (`src/database/schema/`):** Definiciones de tablas Drizzle, relaciones, enums y consultas SQL tipadas.
3. **Manejo Centralizado de Errores:**
   - Todo error controlado hereda de `AppError` (`NotFoundError`, `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`).
   - El middleware global `src/middlewares/error.middleware.ts` captura y estandariza todas las fallas en formato JSON uniforme.

---

## 2. Seguridad, Autenticación y Roles

### 2.1 Modelo de Roles
- `cliente`: Usuario final que solicita servicios técnicos.
- `proveedor`: Titular o dueño de una empresa o negocio independiente de servicios.
- `gerente`: Responsable de sucursal que administra personal técnico y asignación de órdenes.
- `empleado`: Técnico especialista que acude a realizar las reparaciones en campo.
- `administrador`: Personal interno con permisos totales para auditoría, validación de documentos y catálogo.
- `soporte`: Personal interno enfocado en atención de reportes e incidencias.

### 2.2 Tokens y Sesiones
- **Access Token:** JWT firmado con algoritmo simétrico (`HS256`), duración de 15 minutos, con emisor `fixora-api` y audiencia `fixora-client`.
- **Refresh Token:** Token opaco de 64 caracteres criptográficos guardado en PostgreSQL (`sessions`), con rotación automática y expiración a los 30 días.
- **Protección de Sesión:** Invalida automáticamente la sesión al cambiar contraseña o al invocar `/logout`.

### 2.3 Estructura Estándar de Respuestas

#### Respuesta Exitosa (200 OK / 201 Created)
```json
{
  "success": true,
  "message": "Operación realizada correctamente.",
  "data": { ... },
  "pagination": { ... } // Opcional, presente en listados paginados
}
```

#### Respuesta de Error (400, 401, 403, 404, 409, 413, 500)
```json
{
  "error": "CODIGO_ERROR_SEMANTICO",
  "message": "Mensaje legible y descriptivo de la falla.",
  "details": [
    {
      "field": "campo_invalido",
      "message": "Motivo específico de rechazo."
    }
  ]
}
```

---

## 3. Catálogo Exhaustivo de Rutas (Endpoints)

---

### MÓDULO 1: ESTADO DEL SISTEMA (HEALTH & DOCS)

#### 1.1 Información Base de la API
- **Método HTTP:** `GET`
- **Ruta:** `/`
- **Autenticación:** Pública (No requiere token).
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "name": "Fixora API",
    "version": "1.0.0",
    "documentation": "/api/docs",
    "status": "online"
  }
  ```

#### 1.2 Verificación Simple de Vida
- **Método HTTP:** `GET`
- **Ruta:** `/health`
- **Autenticación:** Pública.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "status": "ok",
    "service": "Fixora-Api"
  }
  ```

#### 1.3 Estado Detallado del Sistema
- **Método HTTP:** `GET`
- **Ruta:** `/api/health`
- **Autenticación:** Pública.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "status": "ok",
      "environment": "development",
      "database": "connected",
      "redis": "connected",
      "uptime": 1245.32,
      "timestamp": "2026-11-15T21:42:54.000Z"
    }
  }
  ```
- **Posibles Errores:**
  - `500 INTERNAL_SERVER_ERROR`: Fallo irrecuperable en el servicio.

---

### MÓDULO 2: AUTENTICACIÓN Y REGISTRO (`/api/auth`)

#### 2.1 Registro de Cliente
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/register`
- **Autenticación:** Pública.
- **Headers:** `Content-Type: application/json`
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción / Validaciones |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo electrónico válido (máx. 255 car.). |
  | `password` | `string` | Sí | Mínimo 8 caracteres, máximo 72 bytes. |
  | `name` | `string` | Sí | Nombre del cliente (máx. 100 car.). |
  | `lastname_p` | `string` | Sí | Apellido paterno (máx. 100 car.). |
  | `lastname_m` | `string` | No | Apellido materno (máx. 100 car.). |
  | `birth_date` | `string` | No | Formato `YYYY-MM-DD` (fecha válida pasada). |
  | `phone` | `string` | No | Teléfono de contacto (máx. 30 car.). |
- **Ejemplo Request Body:**
  ```json
  {
    "email": "cliente@ejemplo.com",
    "password": "Password123!",
    "name": "Juan",
    "lastname_p": "Pérez",
    "lastname_m": "Gómez",
    "birth_date": "1995-05-14",
    "phone": "+528711234567"
  }
  ```
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Registro completado. Hemos enviado un código de verificación a tu correo.",
    "email": "cliente@ejemplo.com"
  }
  ```
- **Posibles Errores:**
  - `400 INVALID_INPUT`: Faltan campos obligatorios o formatos incorrectos.
  - `400 INVALID_EMAIL`: Formato de email inválido.
  - `400 INVALID_PASSWORD`: Contraseña demasiado corta o extensa.
  - `409 USER_ALREADY_EXISTS`: El correo ya se encuentra registrado.

#### 2.2 Verificar Correo Electrónico
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/verify-email`
- **Autenticación:** Pública.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo electrónico registrado. |
  | `code` | `string` | Sí | Código numérico de 6 dígitos recibido por correo. |
- **Ejemplo Request Body:**
  ```json
  {
    "email": "cliente@ejemplo.com",
    "code": "481920"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Correo electrónico verificado exitosamente. Tu cuenta ha sido activada."
  }
  ```
- **Posibles Errores:**
  - `400 INVALID_INPUT`: Datos incompletos.
  - `400 INVALID_OR_EXPIRED_CODE`: Código erróneo o tiempo de vida expirado.
  - `404 USER_NOT_FOUND`: No existe usuario para dicho correo.
  - `409 USER_ALREADY_VERIFIED`: La cuenta ya estaba activa.

#### 2.3 Reenviar Código de Verificación
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/resend-verification`
- **Autenticación:** Pública.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo del usuario que necesita nuevo código. |
- **Ejemplo Request Body:**
  ```json
  {
    "email": "cliente@ejemplo.com"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Se ha enviado un nuevo código de verificación a tu correo."
  }
  ```
- **Posibles Errores:**
  - `429 RATE_LIMIT_EXCEEDED`: Debe esperar el período de enfriamiento (cooldown) antes de solicitar otro código.

#### 2.4 Iniciar Sesión (Login)
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/login`
- **Autenticación:** Pública.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo electrónico de la cuenta. |
  | `password` | `string` | Sí | Contraseña en texto plano. |
  | `deviceToken` | `string` | No | Token FCM de dispositivo para notificaciones push móviles. |
  | `devicePlatform` | `string` | No | Plataforma: `'android'`, `'ios'` o `'web'` (defecto: `'android'`). |
- **Ejemplo Request Body:**
  ```json
  {
    "email": "cliente@ejemplo.com",
    "password": "Password123!",
    "deviceToken": "fcm_token_sample_abc123",
    "devicePlatform": "android"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "7a8f9c0e1b2d3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
    "user": {
      "id": "15",
      "email": "cliente@ejemplo.com",
      "role": "cliente",
      "state": "activo"
    }
  }
  ```
- **Posibles Errores:**
  - `400 INVALID_INPUT`: Credenciales no enviadas.
  - `401 INVALID_CREDENTIALS`: Usuario inexistente o contraseña incorrecta.
  - `403 ACCOUNT_PENDING_VERIFICATION`: La cuenta aún no ha verificado su correo.
  - `403 ACCOUNT_LOCKED`: Bloqueo por exceder el máximo de intentos fallidos permitidos.
  - `403 ACCOUNT_SUSPENDED`: Cuenta sancionada o suspendida por administración.

#### 2.5 Renovar Tokens (Refresh Session)
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/refresh`
- **Autenticación:** Pública (requiere refreshToken válido en body).
- **Request Body:**
  ```json
  {
    "refreshToken": "7a8f9c0e1b2d3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "nuevo_refresh_token_rotado_..."
  }
  ```
- **Posibles Errores:**
  - `400 REFRESH_TOKEN_REQUIRED`: Token ausente.
  - `401 INVALID_REFRESH_TOKEN`: Token expirado, revocado o modificado.

#### 2.6 Cerrar Sesión (Logout)
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/logout`
- **Autenticación:** Pública (invalida la sesión del refreshToken provisto).
- **Request Body:**
  ```json
  {
    "refreshToken": "7a8f9c0e1b2d3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
    "deviceToken": "fcm_token_sample_abc123"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Sesión cerrada correctamente."
  }
  ```

---

### MÓDULO 3: RECUPERACIÓN DE CONTRASEÑA (`/api/auth`)

#### 3.1 Solicitar Código de Recuperación
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/forgot-password`
- **Autenticación:** Pública.
- **Request Body:**
  ```json
  {
    "email": "usuario@ejemplo.com"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Si el correo está registrado, recibirás un código para restablecer tu contraseña."
  }
  ```
- **Posibles Errores:**
  - `400 INVALID_INPUT`: Falta el campo email.
  - `429 RATE_LIMIT_EXCEEDED`: Demasiadas solicitudes seguidas.

#### 3.2 Validar Código y Restablecer Contraseña
- **Método HTTP:** `POST`
- **Ruta:** `/api/auth/reset-password`
- **Autenticación:** Pública.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo electrónico del usuario. |
  | `code` | `string` | Sí | Código OTP de 6 dígitos. |
  | `newPassword` / `new_password` | `string` | Sí | Nueva contraseña (mínimo 8 caracteres). |
- **Ejemplo Request Body:**
  ```json
  {
    "email": "usuario@ejemplo.com",
    "code": "849201",
    "newPassword": "NuevaPasswordFuerte!2026"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Tu contraseña ha sido restablecida exitosamente."
  }
  ```
- **Posibles Errores:**
  - `400 INVALID_INPUT`: Faltan campos.
  - `400 INVALID_OR_EXPIRED_CODE`: Código expirado o incorrecto.

---

### MÓDULO 4: GESTIÓN DE PERFIL Y DIRECCIONES (`/api/me`)

Todas las rutas de este módulo requieren token JWT en Header: `Authorization: Bearer <accessToken>`.

#### 4.1 Consultar Datos de Mi Cuenta
- **Método HTTP:** `GET`
- **Ruta:** `/api/me`
- **Autenticación:** Requerida (Cualquier rol activo).
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Datos de la cuenta obtenidos correctamente.",
    "data": {
      "id": "15",
      "email": "cliente@ejemplo.com",
      "role": "cliente",
      "state": "activo",
      "name": "Juan",
      "lastname_p": "Pérez",
      "lastname_m": "Gómez",
      "birth_date": "1995-05-14",
      "phone": "+528711234567"
    }
  }
  ```

#### 4.2 Actualizar Datos Personales
- **Método HTTP:** `PATCH`
- **Ruta:** `/api/me`
- **Autenticación:** Requerida.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `name` | `string` | No | Nombre del usuario. |
  | `lastname_p` | `string` | No | Apellido paterno. |
  | `lastname_m` | `string` | No | Apellido materno o null. |
  | `birth_date` | `string` | No | `YYYY-MM-DD` o null. |
  | `phone` | `string` | No | Teléfono o null. |
- **Ejemplo Request Body:**
  ```json
  {
    "name": "Juan Carlos",
    "phone": "+528719998877"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Datos personales actualizados correctamente.",
    "data": { ... }
  }
  ```

#### 4.3 Cambiar Contraseña
- **Método HTTP:** `PATCH`
- **Ruta:** `/api/me/password`
- **Autenticación:** Requerida.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `current_password` | `string` | Sí | Contraseña vigente. |
  | `new_password` | `string` | Sí | Nueva contraseña (mínimo 8 caracteres). |
- **Ejemplo Request Body:**
  ```json
  {
    "current_password": "PasswordActual123!",
    "new_password": "PasswordNueva456!"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Contraseña actualizada correctamente.",
    "data": {
      "revokedSessionsCount": 2
    }
  }
  ```
- **Posibles Errores:**
  - `400 ACCOUNT_INVALID_PASSWORD`: La contraseña actual no coincide o la nueva no cumple políticas.

#### 4.4 Listar Mis Direcciones
- **Método HTTP:** `GET`
- **Ruta:** `/api/me/addresses`
- **Autenticación:** Requerida.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Direcciones obtenidas correctamente.",
    "data": [
      {
        "id": "1",
        "alias": "Mi Casa",
        "street": "Av. Morelos",
        "num_ext": "123",
        "num_int": "B",
        "colony": "Centro",
        "municipality": "Torreón",
        "state": "Coahuila",
        "postal_code": "27000",
        "country": "México",
        "latitude": 25.5428,
        "longitude": -103.4068,
        "reference": "Frente al parque",
        "is_main": true,
        "active": true
      }
    ]
  }
  ```

#### 4.5 Crear Nueva Dirección
- **Método HTTP:** `POST`
- **Ruta:** `/api/me/addresses`
- **Autenticación:** Requerida.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `street` | `string` | Sí | Calle. |
  | `num_ext` | `string` | Sí | Número exterior. |
  | `num_int` | `string` | No | Número interior. |
  | `colony` | `string` | Sí | Colonia o Fraccionamiento. |
  | `municipality` | `string` | Sí | Municipio / Alcaldía. |
  | `state` | `string` | Sí | Estado o Provincia. |
  | `postal_code` | `string` | Sí | Código postal. |
  | `country` | `string` | No | País (defecto: `'México'`). |
  | `latitude` | `number` | No | Coordenada latitud (-90 a 90). |
  | `longitude` | `number` | No | Coordenada longitud (-180 a 180). |
  | `alias` | `string` | No | Nombre descriptivo (ej. Casa, Oficina). |
  | `reference` | `string` | No | Referencias visuales para el técnico. |
  | `is_main` | `boolean` | No | Establecer como principal por defecto. |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Dirección guardada correctamente.",
    "data": { ... }
  }
  ```

#### 4.6 Consultar una Dirección Específica
- **Método HTTP:** `GET`
- **Ruta:** `/api/me/addresses/:id`
- **Parámetros de Ruta:** `id` (Identificador BigInt de la dirección).
- **Autenticación:** Requerida.

#### 4.7 Modificar una Dirección
- **Método HTTP:** `PATCH`
- **Ruta:** `/api/me/addresses/:id`
- **Parámetros de Ruta:** `id` (Identificador BigInt de la dirección).
- **Autenticación:** Requerida.

#### 4.8 Establecer Dirección Principal
- **Método HTTP:** `PATCH`
- **Ruta:** `/api/me/addresses/:id/main`
- **Parámetros de Ruta:** `id` (Identificador BigInt de la dirección).
- **Autenticación:** Requerida.

#### 4.9 Desactivar (Eliminar) Dirección
- **Método HTTP:** `DELETE`
- **Ruta:** `/api/me/addresses/:id`
- **Parámetros de Ruta:** `id` (Identificador BigInt de la dirección).
- **Autenticación:** Requerida.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Dirección desactivada correctamente.",
    "data": { "id": "1", "active": false }
  }
  ```

---

### MÓDULO 5: CENTRO DE NOTIFICACIONES (`/api/me/notifications`)

#### 5.1 Listar Mis Notificaciones
- **Método HTTP:** `GET`
- **Ruta:** `/api/me/notifications`
- **Autenticación:** Requerida.
- **Query Parameters:**
  | Parámetro | Tipo | Opcional | Descripción |
  | :--- | :--- | :---: | :--- |
  | `unread` | `boolean` | Sí | Filtrar únicamente no leídas (`true` o `false`). |
  | `page` | `number` | Sí | Número de página (defecto: 1). |
  | `limit` | `number` | Sí | Límite por página (1-100, defecto: 20). |
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": [
      {
        "id": "101",
        "title": "Técnico en camino",
        "message": "El técnico Carlos ha iniciado el traslado a tu domicilio.",
        "type": "service_request",
        "read": false,
        "created_at": "2026-11-15T20:10:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1,
      "totalPages": 1
    }
  }
  ```

#### 5.2 Marcar Notificación como Leída
- **Método HTTP:** `POST`
- **Ruta:** `/api/me/notifications/:id/read`
- **Parámetros de Ruta:** `id` (Identificador de la notificación).
- **Autenticación:** Requerida.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente."
  }
  ```

#### 5.3 Marcar Todas las Notificaciones como Leídas
- **Método HTTP:** `POST`
- **Ruta:** `/api/me/notifications/read-all`
- **Autenticación:** Requerida.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente."
  }
  ```

---

### MÓDULO 6: GESTIÓN DE DISPOSITIVOS PUSH FCM (`/api/me/devices`)

#### 6.1 Registrar o Reasignar Token de Dispositivo
- **Método HTTP:** `POST`
- **Ruta:** `/api/me/devices`
- **Autenticación:** Requerida.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `token` | `string` | Sí | Cadena del token de registro proporcionado por FCM. |
  | `platform` | `string` | No | `'android'`, `'ios'` o `'web'` (defecto: `'android'`). |
- **Ejemplo Request Body:**
  ```json
  {
    "token": "dKjs93kd9_s82n...longFCMtoken",
    "platform": "android"
  }
  ```
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Token de dispositivo registrado exitosamente.",
    "data": {
      "id": "5",
      "platform": "android",
      "active": true
    }
  }
  ```

#### 6.2 Desactivar Dispositivo por URL Param
- **Método HTTP:** `DELETE`
- **Ruta:** `/api/me/devices/:token`
- **Parámetros de Ruta:** `token` (Token FCM).
- **Autenticación:** Requerida.

#### 6.3 Desactivar Dispositivo por Body
- **Método HTTP:** `POST`
- **Ruta:** `/api/me/devices/deactivate`
- **Autenticación:** Requerida.
- **Request Body:**
  ```json
  {
    "token": "dKjs93kd9_s82n...longFCMtoken"
  }
  ```

---

### MÓDULO 7: CATÁLOGO DE CATEGORÍAS (`/api/categories`)

#### 7.1 Consultar Categorías Públicas
- **Método HTTP:** `GET`
- **Ruta:** `/api/categories`
- **Autenticación:** Pública.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Categorías obtenidas correctamente.",
    "data": [
      {
        "id": "1",
        "name": "Plomería",
        "slug": "plomeria",
        "icon_key": "icons/plumbing.png",
        "sort_order": 1,
        "active": true
      }
    ]
  }
  ```

#### 7.2 Consultar Categoría Activa por ID
- **Método HTTP:** `GET`
- **Ruta:** `/api/categories/:id`
- **Autenticación:** Pública.

#### 7.3 [Admin] Consultar Todas las Categorías
- **Método HTTP:** `GET`
- **Ruta:** `/api/categories/admin/all`
- **Autenticación:** Requerida (`administrador`).
- **Query Parameters:** `search` (Opcional, filtra por coincidencia de nombre).

#### 7.4 [Admin] Crear Nueva Categoría
- **Método HTTP:** `POST`
- **Ruta:** `/api/categories`
- **Autenticación:** Requerida (`administrador`).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `name` | `string` | Sí | Nombre (2 a 150 caracteres). |
  | `slug` | `string` | No | Slug URL (se autogenera si se omite). |
  | `icon_key` | `string` | No | Llave del archivo de icono. |
  | `sort_order` | `number` | No | Orden de despliegue. |
  | `active` | `boolean` | No | Estado inicial (defecto: `true`). |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Categoría creada correctamente.",
    "data": { ... }
  }
  ```

#### 7.5 [Admin] Actualizar Categoría
- **Método HTTP:** `PATCH`
- **Ruta:** `/api/categories/:id`
- **Autenticación:** Requerida (`administrador`).

#### 7.6 [Admin] Desactivar Categoría
- **Método HTTP:** `DELETE`
- **Ruta:** `/api/categories/:id`
- **Autenticación:** Requerida (`administrador`).

---

### MÓDULO 8: ASISTENTE WEB Y REGISTRO DE PROVEEDORES (`/api/supplier-applications`)

#### 8.1 Catálogo de Documentos Requeridos
- **Método HTTP:** `GET`
- **Ruta:** `/api/document-types`
- **Autenticación:** Pública.
- **Query Parameters:** `supplier_type` (`independiente`, `empresa` o `ambos`).
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "data": [
      {
        "id": "1",
        "name": "Constancia de Situación Fiscal (RFC)",
        "doc_supplier_type": "ambos",
        "is_required": true
      }
    ]
  }
  ```

#### 8.2 Enviar Solicitud de Registro de Proveedor
- **Método HTTP:** `POST`
- **Ruta:** `/api/supplier-applications`
- **Autenticación:** Pública (Asistente web de registro).
- **Headers:** `Content-Type: application/json` o `multipart/form-data` con campo `data`.
- **Request Body:**
  | Sección | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :--- | :---: | :--- |
  | **manager** | `email` | `string` | Sí | Correo del titular de la cuenta. |
  | | `password` | `string` | Sí | Contraseña para su usuario proveedor. |
  | | `name` | `string` | Sí | Nombre del titular. |
  | | `lastname_p` | `string` | Sí | Apellido paterno. |
  | | `phone` | `string` | No | Teléfono de contacto. |
  | **general** | `supplier_type` | `string` | Sí | `'independiente'` o `'empresa'`. |
  | | `rfc` | `string` | No | Registro Federal de Contribuyentes. |
  | **business** | `name` | `string` | Sí | Razón social o nombre comercial. |
  | **branches** | Array de sucursales | `object[]` | Sí | Al menos 1 sucursal obligatoria. |
  | ↳ branch | `name` | `string` | Sí | Nombre de la sucursal matriz/local. |
  | ↳ branch | `address` | `object` | Sí | Dirección con coordenadas lat/long. |
  | ↳ branch | `schedules` | `object[]` | Sí | Días (`0` a `6`) y horarios `open_time`/`close_time`. |
  | ↳ branch | `categories` | `object[]` | Sí | Categorías atendidas con `base_price`. |
  | **documents** | Array de documentos | `object[]` | No | Documentos iniciales subidos (`file_key`, `type_document_id`). |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "data": {
      "id": "1",
      "supplier_id": "4",
      "supplier_type": "empresa",
      "state": "pendiente",
      "business_name": "FixMaster Servicios",
      "email": "contacto@fixmaster.com"
    },
    "message": "Solicitud de proveedor recibida exitosamente."
  }
  ```

#### 8.3 Consultar Estado de Solicitud de Proveedor
- **Método HTTP:** `GET`
- **Ruta:** `/api/supplier-applications/status`
- **Query Parameters:** `?email=...` o `?application_id=...`
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "data": {
      "application_id": "1",
      "state": "pendiente",
      "supplier_type": "empresa",
      "business_name": "FixMaster Servicios",
      "documents": [ ... ]
    }
  }
  ```

#### 8.4 [Proveedor] Consultar Mi Solicitud Autenticada
- **Método HTTP:** `GET`
- **Ruta:** `/api/supplier-applications/me`
- **Autenticación:** Requerida (`proveedor`).

#### 8.5 [Proveedor] Reemplazar Documento Rechazado
- **Método HTTP:** `PUT`
- **Ruta:** `/api/supplier-applications/me/documents/:typeDocumentId` o `/api/supplier-applications/:id/documents/:typeDocumentId`
- **Autenticación:** Requerida (`proveedor`).
- **Headers:** `Content-Type: multipart/form-data` o `application/json` con `file_key`.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `file` | Archivo binario | No | Si se envía multipart. |
  | `file_key` | `string` | No | Si se subió previamente en `/api/files/upload`. |
  | `due_date` | `string` | No | Fecha de vigencia en formato `YYYY-MM-DD`. |
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "data": { ... },
    "application_state": "pendiente",
    "message": "Documento reemplazado exitosamente."
  }
  ```

---

### MÓDULO 9: AUDITORÍA Y RESOLUCIÓN ADMINISTRATIVA (`/api/admin`)

Todas las rutas de este módulo requieren token JWT y rol `administrador`.

#### 9.1 [Admin] Listar Solicitudes de Registro de Proveedores
- **Método HTTP:** `GET`
- **Ruta:** `/api/admin/supplier-applications`
- **Autenticación:** Requerida (`administrador`).
- **Query Parameters:**
  | Parámetro | Tipo | Opcional | Descripción |
  | :--- | :--- | :---: | :--- |
  | `state` | `string` | Sí | Filtrar por: `pendiente`, `aprobada`, `rechazada`, `documentacion_incompleta`. |
  | `search` | `string` | Sí | Búsqueda por nombre de negocio o correo. |
  | `page` | `number` | Sí | Número de página (defecto: 1). |
  | `limit` | `number` | Sí | Resultados por página (defecto: 20). |
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": [ ... ],
    "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
  }
  ```

#### 9.2 [Admin] Consultar Detalle Completo de una Solicitud
- **Método HTTP:** `GET`
- **Ruta:** `/api/admin/supplier-applications/:id`
- **Autenticación:** Requerida (`administrador`).

#### 9.3 [Admin] Revisar Documento de Proveedor
- **Método HTTP:** `PATCH`
- **Ruta:** `/api/admin/supplier-documents/:id`
- **Autenticación:** Requerida (`administrador`).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `result` | `string` | Sí | `'aprobado'` o `'rechazado'`. |
  | `comment` | `string` | Condicional | Obligatorio si el resultado es `'rechazado'`. Máximo 1000 caracteres. |
- **Ejemplo Request Body:**
  ```json
  {
    "result": "rechazado",
    "comment": "La constancia no está vigente; debe tener menos de 3 meses."
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Revisión guardada correctamente.",
    "data": { ... }
  }
  ```

#### 9.4 [Admin] Emitir Resolución de Solicitud de Proveedor
- **Método HTTP:** `POST`
- **Ruta:** `/api/admin/supplier-applications/:id/resolution`
- **Autenticación:** Requerida (`administrador`).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `state` | `string` | Sí | `'aprobada'`, `'rechazada'` o `'documentacion_incompleta'`. |
  | `comments` | `string` | Condicional | Obligatorio si es rechazada o incompleta. |
- **Ejemplo Request Body:**
  ```json
  {
    "state": "aprobada",
    "comments": "Toda la documentación y datos han sido validados."
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Solicitud resuelta correctamente.",
    "data": { ... }
  }
  ```

#### 9.5 [Admin] Alta de Personal Interno (Staff)
- **Método HTTP:** `POST`
- **Ruta:** `/api/admin/staff`
- **Autenticación:** Requerida (`administrador`).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo institucional. |
  | `password` | `string` | Sí | Contraseña segura. |
  | `name` | `string` | Sí | Nombre. |
  | `lastname_p` | `string` | Sí | Apellido paterno. |
  | `lastname_m` | `string` | No | Apellido materno. |
  | `role` | `string` | Sí | `'administrador'` o `'soporte'`. |
  | `phone` | `string` | No | Teléfono de contacto. |
  | `birth_date` | `string` | No | `YYYY-MM-DD`. |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": {
      "id": "10",
      "email": "soporte1@fixora.com",
      "role": "soporte"
    }
  }
  ```

---

### MÓDULO 10: SUCURSALES, EMPLEADOS Y DISPONIBILIDAD (`/api/branches`)

#### 10.1 Consultar Disponibilidad de Agenda de una Sucursal
- **Método HTTP:** `GET`
- **Ruta:** `/api/branches/:id/availability`
- **Autenticación:** Requerida.
- **Parámetros de Ruta:** `id` (ID de la sucursal).
- **Query Parameters:**
  | Parámetro | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `category_id` | `string` | Sí | ID de la categoría a consultar. |
  | `date` | `string` | Sí | Fecha a consultar en formato `YYYY-MM-DD`. |
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": {
      "branch_id": "1",
      "date": "2026-11-20",
      "duration_minutes": 60,
      "available_slots": [
        "09:00", "10:00", "11:00", "15:00", "16:00"
      ]
    }
  }
  ```

#### 10.2 Listar Empleados de una Sucursal
- **Método HTTP:** `GET`
- **Ruta:** `/api/branches/:id/employees`
- **Autenticación:** Requerida (Gerente o Proveedor dueño).
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": [
      {
        "id": "7",
        "name": "Carlos",
        "lastname_p": "Méndez",
        "email": "carlos@fixmaster.com",
        "role": "empleado",
        "can_attend": true
      }
    ]
  }
  ```

#### 10.3 Crear Empleado / Técnico en Sucursal
- **Método HTTP:** `POST`
- **Ruta:** `/api/branches/:id/employees`
- **Autenticación:** Requerida (Gerente o Proveedor dueño).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `email` | `string` | Sí | Correo del nuevo empleado. |
  | `password` | `string` | Sí | Contraseña inicial. |
  | `name` | `string` | Sí | Nombre. |
  | `lastname_p` | `string` | Sí | Apellido paterno. |
  | `lastname_m` | `string` | No | Apellido materno. |
  | `phone` | `string` | No | Teléfono. |
  | `role` | `string` | Sí | `'gerente'` o `'empleado'`. |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": { ... }
  }
  ```

---

### MÓDULO 11: SOLICITUDES DE SERVICIO (`/api/service-requests`)

#### 11.1 Listar Mis Solicitudes de Servicio
- **Método HTTP:** `GET`
- **Ruta:** `/api/service-requests`
- **Autenticación:** Requerida.
- **Filtro automático según rol:**
  - `cliente`: Sus servicios contratados.
  - `empleado`: Servicios asignados al técnico.
  - `gerente` o `proveedor`: Servicios de su sucursal / negocio.
- **Query Parameters:**
  | Parámetro | Tipo | Opcional | Descripción |
  | :--- | :--- | :---: | :--- |
  | `status` | `string` | Sí | Filtrar por: `pendiente`, `aceptada`, `agendada`, `en_camino`, `llegado`, `completada`, `cancelada`, `expirada`. |
  | `page` | `number` | Sí | Página (defecto: 1). |
  | `limit` | `number` | Sí | Límite por página (1-100, defecto: 20). |
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": [ ... ],
    "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
  }
  ```

#### 11.2 Crear y Enviar Solicitud de Servicio
- **Método HTTP:** `POST`
- **Ruta:** `/api/service-requests`
- **Autenticación:** Requerida (Rol `cliente`).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `client_uuid` | `string` | Sí | UUID idempotente v4 generado por el cliente móvil/web. |
  | `branch_id` | `string` | Sí | Identificador de la sucursal elegida. |
  | `category_id` | `string` | Sí | Identificador de la categoría del trabajo. |
  | `description` | `string` | Sí | Descripción del problema (hasta 2000 car.). |
  | `address_id` | `string` | Condicional | ID de dirección existente guardada (excluyente con `address`). |
  | `address` | `object` | Condicional | Objeto dirección nueva (excluyente con `address_id`). |
  | `attachment_keys` | `string[]` | No | Lista de hasta 5 llaves de fotos previas subidas. |
  | `scheduled_at` | `string` | No | Fecha/hora ISO si es cita programada; si se omite, es servicio urgente inmediato. |
- **Ejemplo Request Body (Urgente con dirección guardada):**
  ```json
  {
    "client_uuid": "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
    "branch_id": "1",
    "category_id": "3",
    "description": "Fuga severa de agua bajo el fregadero de la cocina.",
    "address_id": "2",
    "attachment_keys": ["evidences/user15_c9bf9e57_photo1.jpg"]
  }
  ```
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Solicitud enviada al proveedor.",
    "data": {
      "id": "52",
      "status": "pendiente",
      "expires_at": "2026-11-15T22:05:00.000Z"
    }
  }
  ```

#### 11.3 Consultar Detalle de una Solicitud
- **Método HTTP:** `GET`
- **Ruta:** `/api/service-requests/:id`
- **Autenticación:** Requerida (Involucrados: Cliente, Técnico, Gerente o Proveedor).

#### 11.4 Actualizar Estado de una Solicitud (Transición de Ciclo de Vida)
- **Método HTTP:** `POST`
- **Ruta:** `/api/service-requests/:id/status`
- **Autenticación:** Requerida (Técnico asignado o Gerente).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `status` | `string` | Sí | Nuevo estado: `'en_camino'`, `'llegado'`, `'completada'`. |
  | `latitude` | `number` | Sí | Latitud actual del técnico (-90 a 90). |
  | `longitude` | `number` | Sí | Longitud actual del técnico (-180 a 180). |
  | `closing_keys` | `string[]` | No | Fotos de evidencia de conclusión (solo admitidas al pasar a `'completada'`). |
- **Ejemplo Request Body (Técnico en camino):**
  ```json
  {
    "status": "en_camino",
    "latitude": 25.5428,
    "longitude": -103.4068
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": {
      "id": "52",
      "status": "en_camino"
    }
  }
  ```

#### 11.5 Consultar Bitácora Histórica de Eventos
- **Método HTTP:** `GET`
- **Ruta:** `/api/service-requests/:id/events`
- **Autenticación:** Requerida.
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": [
      {
        "id": "1",
        "from_status": null,
        "to_status": "pendiente",
        "changed_by": "15",
        "created_at": "2026-11-15T21:00:00.000Z"
      },
      {
        "id": "2",
        "from_status": "pendiente",
        "to_status": "aceptada",
        "changed_by": "7",
        "created_at": "2026-11-15T21:03:00.000Z"
      }
    ]
  }
  ```

#### 11.6 Solicitud de Emergencia y Despacho a Técnicos Cercanos (API-28)
- **Método HTTP:** `POST`
- **Ruta:** `/api/service-requests/emergency`
- **Autenticación:** Requerida (Rol `cliente`).
- **Descripción:** Solo pide la categoría y la ubicación actual. Busca técnicos cercanos disponibles ordenados por proximidad (usando la última posición GPS en Redis GEO o la dirección de su sucursal). Avisa de forma concurrente mediante notificaciones de alta prioridad FCM y canales WebSocket a los técnicos elegibles. Registra cada aviso en `request_dispatches`.
- **Carrera de aceptación:** El primer técnico que acepta se queda con la solicitud y a los demás se les retira automáticamente.
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `client_uuid` | `string (uuid)` | Sí | Identificador único de idempotencia del cliente. |
  | `category_id` | `string` | Sí | Identificador de la categoría del servicio requerido. |
  | `latitude` | `number` | Sí | Latitud actual del cliente (-90 a 90). |
  | `longitude` | `number` | Sí | Longitud actual del cliente (-180 a 180). |
  | `description` | `string` | No | Breve descripción del problema (máx. 500 caracteres). |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Operación realizada correctamente.",
    "data": {
      "id": "120",
      "status": "pendiente",
      "is_emergency": true,
      "description": "Tubería rota con fuga activa",
      "category": { "id": "5", "name": "Plomería" },
      "branch": null,
      "technician": null,
      "client": { "name": "Juan Pérez", "rating_avg": 4.9 },
      "address": {
        "id": "31",
        "alias": "Emergencia",
        "reference": "Ubicación enviada mediante botón de emergencia.",
        "street": "Ubicación actual",
        "num_ext": "S/N",
        "num_int": null,
        "colony": "GPS",
        "municipality": "Emergencia",
        "state": "Ubicación actual",
        "postal_code": "00000",
        "country": "México",
        "latitude": 19.4326,
        "longitude": -99.1332,
        "is_main": false
      },
      "base_price": "350.00",
      "agreed_price": "350.00",
      "attachments": [],
      "created_at": "2026-11-16T03:33:19.436Z",
      "expires_at": "2026-11-16T03:38:19.436Z",
      "scheduled_at": null,
      "accepted_at": null,
      "arrived_at": null,
      "completed_at": null,
      "canceled_by": null,
      "canceled_reason": null
    }
  }
  ```
- **Errores Posibles:**
  - `400 VALIDATION_ERROR`: Datos enviados inválidos o incompletos.
  - `401 INVALID_ACCESS_TOKEN`: Token faltante o expirado.
  - `403 INSUFFICIENT_PERMISSIONS`: Usuario no es cliente.
  - `409 NO_TECHNICIANS_AVAILABLE`: No hay técnicos disponibles en el radio de cobertura.

#### 11.7 Aceptar Solicitud de Servicio (Proveedor / Técnico) (API-30)
- **Método HTTP:** `POST`
- **Ruta:** `/api/service-requests/:id/accept`
- **Autenticación:** Requerida (Rol `empleado`, `gerente` o `proveedor`).
- **Descripción:** Detiene el temporizador de expiración en Redis. En solicitudes de emergencia, el primer técnico que acepta gana la asignación: actualiza su registro en `request_dispatches` a `'acepto'`, marca a todos los demás técnicos convocados como `'expiro'` y les envía el evento en tiempo real `service_request_withdrawn`.
- **Respuesta Exitosa (200 OK):** Detalle de la solicitud en estado `aceptada`.

#### 11.8 Rechazar Solicitud de Servicio (API-30)
- **Método HTTP:** `POST`
- **Ruta:** `/api/service-requests/:id/reject`
- **Autenticación:** Requerida (Rol `empleado`, `gerente` o `proveedor`).
- **Descripción:** En solicitudes de emergencia, solo retira la solicitud para el técnico que rechaza actualizando su registro en `request_dispatches` a `'rechazo'`, manteniéndola disponible para los demás técnicos convocados.
- **Respuesta Exitosa (200 OK):** `{ "success": true, "message": "Operación realizada correctamente." }`.

---

### MÓDULO 12: ALMACENAMIENTO SEGURO DE ARCHIVOS (`/api/files`)

#### 12.1 Subir Archivo
- **Método HTTP:** `POST`
- **Ruta:** `/api/files/upload`
- **Autenticación:** Requerida.
- **Headers:** `Content-Type: multipart/form-data`
- **Form Data:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `file` | Binario | Sí | Archivo a subir (JPG, PNG, WEBP, PDF, MP4). Máx. 15MB. |
  | `category` | `string` | No | `'documents'`, `'photos'` o `'evidences'` (defecto: `'documents'`). |
  | `is_verification` | `boolean` | No | `true` si es documento sensible de acreditación legal. |
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "success": true,
    "message": "Archivo subido y almacenado exitosamente.",
    "data": {
      "file_key": "evidences/15_1731707000000_f7a8b9.jpg",
      "original_name": "fuga_fregadero.jpg",
      "mime_type": "image/jpeg",
      "size_bytes": 245120
    }
  }
  ```

#### 12.2 Generar Enlace Firmado Temporal
- **Método HTTP:** `POST`
- **Ruta:** `/api/files/signed-url`
- **Autenticación:** Requerida (Si el archivo es de verificación legal, solo el `administrador` puede firmarlo).
- **Request Body:**
  | Campo | Tipo | Obligatorio | Descripción |
  | :--- | :--- | :---: | :--- |
  | `file_key` | `string` | Sí | Llave del archivo devuelta al subirlo. |
  | `expires_in_minutes` | `number` | No | Vigencia en minutos (defecto: 30 min). |
  | `disposition` | `string` | No | `'inline'` (previsualizar) o `'attachment'` (forzar descarga). |
- **Ejemplo Request Body:**
  ```json
  {
    "file_key": "evidences/15_1731707000000_f7a8b9.jpg",
    "expires_in_minutes": 60,
    "disposition": "inline"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "url": "/api/files/view?key=evidences%2F15_...&expires=1731710600&signature=3a8f9c...",
      "expires_at": "2026-11-15T22:30:00.000Z"
    }
  }
  ```

#### 12.3 Descargar Archivo Mediante Enlace Firmado
- **Método HTTP:** `GET`
- **Ruta:** `/api/files/download`
- **Autenticación:** Pública (Valida vigencia y firma HMAC en query params).
- **Query Parameters:** `key`, `expires`, `signature`, `disposition`, `name`.
- **Respuesta Exitosa (200 OK):** Stream binario del archivo con `Content-Disposition: attachment`.

#### 12.4 Previsualizar Archivo en Navegador Mediante Enlace Firmado
- **Método HTTP:** `GET`
- **Ruta:** `/api/files/view`
- **Autenticación:** Pública (Valida vigencia y firma HMAC en query params).
- **Respuesta Exitosa (200 OK):** Stream binario con `Content-Disposition: inline`.

#### 12.5 Eliminar Archivo
- **Método HTTP:** `DELETE`
- **Ruta:** `/api/files`
- **Autenticación:** Requerida (Solo el dueño que lo subió o el `administrador`).
- **Request Body:**
  ```json
  {
    "file_key": "evidences/15_1731707000000_f7a8b9.jpg"
  }
  ```
- **Respuesta Exitosa (200 OK):**
  ```json
  {
    "success": true,
    "message": "Archivo eliminado correctamente."
  }
  ```

---

### MÓDULO 13: USUARIOS DE SISTEMA (`/api/users`)

#### 13.1 [Admin] Listar Todos los Usuarios
- **Método HTTP:** `GET`
- **Ruta:** `/api/users`
- **Autenticación:** Requerida (`administrador`).

#### 13.2 [Admin] Consultar Usuario por ID
- **Método HTTP:** `GET`
- **Ruta:** `/api/users/:id`
- **Autenticación:** Requerida (`administrador`).

---

### MÓDULO 14: ENTORNO DE DESARROLLO Y PRUEBAS (`/api/dev`)

*Deshabilitado en ambiente de producción (`NODE_ENV === 'production'`)*.

#### 14.1 Crear Usuario de Prueba
- **Método HTTP:** `POST`
- **Ruta:** `/api/dev/users`
- **Autenticación:** Pública (Solo disponible fuera de producción).
- **Request Body:**
  ```json
  {
    "email": "test_tecnico@fixora.local",
    "password": "Password123!",
    "role": "empleado",
    "status": "activo"
  }
  ```
- **Respuesta Exitosa (201 Created):**
  ```json
  {
    "id": "88",
    "email": "test_tecnico@fixora.local",
    "role": "empleado",
    "status": "activo"
  }
  ```

---

## 4. API en Tiempo Real (WebSocket Server)

### 4.1 Especificación de Conexión
- **URL Local:** `ws://localhost:3001/ws` (puerto configurable vía `PORT`).
- **URL Producción:** `wss://api.fixora.com/ws`
- **Tiempo límite de autenticación:** 5 segundos. Si el cliente no envía el mensaje de autenticación dentro de los primeros 5 segundos tras abrir el socket, la conexión se cierra con código `4401`.

### 4.2 Protocolo de Mensajes Cliente -> Servidor

#### A. Autenticación Inicial
```json
{
  "type": "authenticate",
  "token": "<JWT_ACCESS_TOKEN>"
}
```
- **Respuesta Servidor:**
  ```json
  {
    "type": "authenticated",
    "user": { "id": "15", "role": "cliente" },
    "rooms": ["users:15"]
  }
  ```

#### B. Suscribirse a una Solicitud en Curso
```json
{
  "type": "subscribe_request",
  "requestId": "52"
}
```
*Solo admitido si el usuario es cliente titular, técnico asignado o gerente de la sucursal asignada.*

#### C. Desuscribirse de una Solicitud
```json
{
  "type": "unsubscribe_request",
  "requestId": "52"
}
```

#### D. Keep-Alive / Latencia (Ping)
```json
{
  "type": "ping"
}
```
- **Respuesta Servidor:**
  ```json
  {
    "type": "pong",
    "timestamp": "2026-11-15T21:42:54.000Z"
  }
  ```

### 4.3 Eventos Reactivos Servidor -> Cliente
Cuando se actualiza el estado de una solicitud (ej. técnico en camino o llegado), `RealTimeObserver` emite a la sala `requests:<requestId>`:
```json
{
  "type": "event",
  "event": "service_request_updated",
  "channel": "requests:52",
  "data": {
    "requestId": "52",
    "status": "en_camino",
    "previousStatus": "aceptada",
    "latitude": 25.5428,
    "longitude": -103.4068
  },
  "timestamp": "2026-11-15T21:42:54.000Z"
}
```
