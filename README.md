# Fixora API

API de Fixora (Express + TypeScript).

## Redis

Redis guarda solo datos de tiempo real: temporizadores de solicitudes, posición y disponibilidad de técnicos. Los códigos que se mandan por correo van en PostgreSQL.

Se levanta con Docker, igual en local que en el servidor:

```bash
docker compose up -d redis
```

El contenedor se reinicia solo, guarda sus datos en el volumen `redis-data` y solo escucha en `127.0.0.1`, así que no queda expuesto a internet.

La API se conecta a `REDIS_URL` (por defecto `redis://localhost:6379`). Si Redis no está disponible, la API arranca igual, sigue reintentando y `GET /api/health` lo reporta como `redis: "error"`. Las claves se arman en `src/utils/redis-keys.ts`.

## Commits

Los commits siguen Conventional Commits con el ID de la tarea de Plane:

```txt
<tipo>(<ámbito>): <descripción> (API-XX)
```

El hook `.githooks/commit-msg` rechaza los mensajes que no cumplen el formato. Se activa solo con `pnpm install`; para activarlo a mano:

```bash
git config core.hooksPath .githooks
```

Cada pull request pasa además por el workflow `Conventional Commits`, que revisa el nombre de la rama, el título del PR y los commits.
