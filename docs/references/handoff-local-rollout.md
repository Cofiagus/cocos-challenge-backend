# Handoff — corte de integración y pruebas locales

**Corte solicitado por el usuario el 2026-11-05, 20:45 (-03).** No continuar pruebas, migraciones ni servicios en esta sesión. Una notificación tardía de un subagente no levanta esta pausa.

## Punto de entrada

- Repo: `/home/cofi/repos/cocos-challenge-backend`, máquina local `cofi-pc`, rama `main`.
- Código integrado: `bd60d65` (merge de candidata `63e65ac`, QA independiente ACCEPT **9.5/10**).
- Último commit antes del corte: `55ea2ee` (cierra G0 autorizado). El commit que incorpora este handoff sólo cambia documentación; obtener su SHA con `git log -1`.
- Estado operativo único: sección **Activo** de `PROGRESS.md`. Leerla antes de actuar; después `AGENTS.md` y `docs/CODEMAP.md`.
- Plan aprobado: `specs/integracion-instrumentos-despliegue-local.md`, Rev. 3, firma humana «SI APRUEBO». No reabrir D1–D5 ni UC-2. El padre supervisa/verifica/integra; implementación delegada a DS/GLM.

## Qué está realmente verificado

**G1/G2 cerrados.** Prisma generate, typecheck, lint, build y OpenAPI determinista verdes. Suite completa repetida en candidata, QA independiente y main: **42 suites / 581 tests / 118 funcionales / 19 aceptación de grandes montos / 0 fallos, pendientes y todo / openHandles=[]**. Núcleo financiero, schema, migraciones y dependencias congelados sin cambios durante UC-2. `.env` y `.env.test` preservados por SHA256; sin push.

Reportes privados durables del perfil en `/home/cofi/.hermes/profiles/cocos-backend/run-logs/instruments-rollout-20261105/`:
- `candidate-63e65ac-jest.{json,log}`.
- `g2-qa-63e65ac-jest.{json,log}` y `g2-qa-63e65ac-gates.log`.
- `main-63e65ac-jest.{json,log}`.

**G0 también cerrado.** El usuario renovó explícitamente la autorización de sólo lectura y pidió un diagrama antes/después. El supervisor ejecutó el SQL auditado en transacciones REPEATABLE READ READ ONLY: app = clon restaurado = snapshot histórico; 0 sesiones ajenas y 0 violaciones de guardas. Backup/checksums e historia inicial correctos. Se compararon 297 marcadores de datos/DDL; G0TX se verificó por separado. El primer intento de comparación tuvo un problema de parser por cabeceras del antiguo formato psql alineado, corregido sin cambiar SQL ni datos. No es una anomalía financiera.

Evidencia G0: subdirectorio `g0-supervisor-20261105T233941Z/` del directorio anterior: `summary.json`, `app-readback.txt`, `clone-readback.txt`, `schema-before.actual-app.json`, `schema-after.validated-test.json` y `verify-g0-and-schema.py`. El helper es **pre-migración**, no ejecutarlo ciegamente después de migrar. El SQL auditado original y el dump permanecen en el backup privado `backups/instruments-rollout-20261105/` del perfil. No adjuntar backups ni secretos al chat.

## Entorno y límites al corte

| Recurso | Destino / estado observado |
|---|---|
| DB app preexistente | `127.0.0.1:5433`, `cocos_challenge`; sólo migración inicial aplicada; `large_money` pendiente |
| Clon conservado | `127.0.0.1:55432`, `a0_restore_rehearsal_20261105`; restaurado del backup de la app, NO base de tests destructivos |
| DB base de última suite main | `127.0.0.1:55432`, `cocos_rollout_main_gate_test` |
| DB base QA | `127.0.0.1:55432`, `cocos_rollout_g2_qa_test` |
| API | No fue arrancada; último chequeo sin listener en 3000 |

Los PostgreSQL se observaron en loopback y se dejan sin modificar al cortar. Revalidar estado al retomar, no asumir PIDs vigentes. Puerto 5432 ajeno: no tocar. No se ejecutaron migración app, seed/reset app, escrituras HTTP sobre app ni Yahoo real. G3/G4/G5 siguen abiertos. La diferencia legacy de cash de la orden 12 está documentada: no reconstruir centavos automáticamente.

`.env.test` heredado no es una configuración segura por default para esta ejecución: los gates usaron entorno explícito hacia **55432**. No correr `npm test`/reset sin verificar el destino y el guard de app. Las suites completas deben correr **secuencialmente**: varias suites usan nombres fijos de DB aunque cambie la DB base. Worktree y cliente Prisma propios por ejecutor.

## Diagrama: trabajo interrumpido y preservado

- Célula `deleg_1c3ab612`, subagente `sa-0-02723e3e`: **interrupción confirmada por el gateway**. Su reporte tardío se archivó sin reanudar trabajo. No queda esta célula en ejecución; no relanzarla automáticamente.
- Worktree: `/home/cofi/repos/coccb-wt-local-rollout-docs-narrative`.
- Rama: `docs/db-schema-before-after`, base `bd60d65`.
- Tras confirmar la interrupción permanecen **dos archivos untracked**, sin QA ni render verificado: `docs/references/db-schema-before-after.html` y `.md`. No están integrados en main. `cmp` confirmó que ambos coinciden byte a byte con el snapshot privado del corte; reconfirmar estado/HEAD al retomar.
- Se preservó una copia de los bytes observados en `/home/cofi/.hermes/profiles/cocos-backend/backups/session-cut-20261105T234536Z/diagram/`, permisos privados. Puede ser un borrador: no se certifica su completitud.
  - HTML SHA256: `a047ed705c958f2f2fd0e388572927a3d8860c3ea7a9a7c87742c160d95f1e84`.
  - MD SHA256: `d13a7bde3a801ba2bd503164d43ba1b8b77ba97f3282a63f6111858df7f256c9`.

Fuentes del diagrama: catálogos G0 citados arriba. **Antes** = app real. **Después** = estructura de la migración observada en una DB de test, NO aplicada a app. Diferencias verificadas: 8 columnas de orders/marketdata a NUMERIC(24,2) y 6 CHECK; sin nuevas tablas, columnas, FK, índices, enums ni cambios de nullabilidad/defaults. Acciones siguen enteras/acotadas a INT4 por CHECK; cash admite centavos. No inventar tablas de saldos, price_ticks ni ingesta Yahoo.

## Orden para retomar en otra sesión

1. Leer este handoff + PROGRESS activo, consultar Git de main y del worktree del diagrama. Preservar borradores; no limpiar untracked ni sobrescribir entornos.
2. Según el nuevo pedido humano, completar/revisar el diagrama contra los JSON reales, comprobar HTML/SVG y visualización, correr typecheck/lint/15 tests docs y obtener QA antes de integrar los dos documentos. Mostrarlo distinguiendo objetivo de aplicación real.
3. Si se retoma el despliegue aprobado, seguir A3 del plan: único operador GLM, revalidación fresca de destino/writers/backup, migrate deploy versionado, comparación económica antes/después y segundo deploy idempotente. No saltar de G0 al arranque.
4. Sólo tras G3: A4 (incluido listener realmente loopback, no asumir HOST soportado), A5 HTTP read-only app/escrituras sólo test y Yahoo real, y A6 exclusivamente por fallos reproducidos. No presentar fakes como proveedor real ni cerrar el despliegue sin evidencia.

Durante este corte **no se repiten tests**: se conservan los resultados ya medidos. La verificación del handoff se limita al diff documental y su commit.
