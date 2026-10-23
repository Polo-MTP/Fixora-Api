# Fixora API

API de Fixora (Express + TypeScript).

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
