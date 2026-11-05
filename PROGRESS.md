# PROGRESS.md — ejecución por células

## Build activo: grandes montos (firma humana 2026-11-05)

- Spec inmutable: `specs/datos-financieros-grandes-montos.md` Rev. 2; D1–D5 aprobadas.
- Rama integradora: `feature/large-money`; worktree `/home/cofi/repos/coccb-wt-large-money`.
- Snapshot base: `b8006afbaaf8e8af3bfc7cf76a63bb557ae6f502` (`snapshot/large-money-20261105`), creado con índice Git alternativo. HEAD y staging originales de main se conservaron; sólo se registró la firma en la spec del árbol original.
- Gate base medido sobre ese commit: **33 suites / 352 tests**, typecheck y lint verdes. PostgreSQL 18.6 nuevo, sólo loopback y puerto 55432, en scratch del perfil; ninguna conexión a DB de app.
- El worktree original contiene trabajo previo del usuario que forma parte del snapshot, no del diff de esta feature. Preservar árbol e índice. El usuario autorizó posteriormente integrar a main tras terminar la implementación, revisión independiente y pruebas completas verdes; no autorizó migrar la DB de la app.
- Gate final exige toda la spec, integración/funcionales con DB real, y revisión independiente. Las células iniciales tienen gates de alcance; ninguna declara verde global hasta adaptar todos los consumidores del contrato incompatible.

| Célula | Alcance / ownership | Estado | Gate |
|---|---|---|---|
| LM-A | Constructor/contratos de dinero y tests monetarios; CODEMAP sólo sus filas | ACEPTADA e integrada hasta 1099fb4 | typecheck/lint/build + 48 tests re-corridos en integradora |
| LM-B | Schema, migración nueva y pruebas PG de almacenamiento/preflight | INTEGRADA: 2bfcf26/e659a09 | 22 tests PG y CHECK NULL re-corridos; cliente nuevo generado |
| LM-C0 | Tipos discriminados y schemas quantity/size | INTEGRADA: 8d1930c/c665109 | contratos y consumidores ya verificados en gate final de feature |
| LM-C1-pure | Dominio puro y ports; cell/large-money-pure-final | INTEGRADA: 3938ec0 | 64 unit/domain re-corridos; sizing RangeError antes de convertir; lint verde |
| LM-C1-app | Casos de uso, HTTP y fakes unitarios; cell/large-money-app-final | INTEGRADA desde 835699a en este merge | 137 unit application/HTTP re-corridos; typecheck global recuperado |
| LM-D-final | Mappers, repos e idempotencia histórica; cell/large-money-infra-final | INTEGRADA desde 86dcbb4 en este merge | 117 tests infra verdes; origen coherente y evidencia obligatoria, sin truncar cash nuevo |
| LM-E-docs | README/docs/colección del contrato aprobado | INTEGRADA: 4f9974f/e27f99a/ee5703f | correcciones revisadas; aún no afirma ejecución API final |
| LM-E-wire-final | OpenAPI; cell/large-money-wire-final | INTEGRADA: 3477ff9 | 15 tests/docs re-corridos; schemas monetarios únicos; lint verde |
| LM-F-trading | tests/functional/{orders,orders-submit}; cell/large-money-functional-trading-final | INTEGRADA desde 4cb6324 (360ae4e) | 47 tests HTTP+PG re-corridos; gate completo detectOpenHandles=[] |
| LM-F-cash | tests/functional/{read,cancel,transfers}; cell/large-money-functional-cash-final | INTEGRADA desde 0ccebda en este merge | 42 tests HTTP+PG re-corridos; typecheck/lint verdes; 0.50 FILLED exacto por D4 |
| LM-F-acceptance | tests/functional/large-money nuevos; cell/large-money-acceptance-final | INTEGRADA desde 54ef051 en este merge | 19 E2E re-corridos; máximos/centavos/concurrencia/replays/rollback real |
| LM-QA | Revisión independiente de diff e invariantes del runtime b55a8db | ACCEPT runtime, 8.5/10 (DeepSeek); cierre global PENDIENTE | matriz invariante → implementación → test entregada; sin bug de fuente confirmado; falta e2e final |
| LM-QA-polish | Precisión docs CHECK y tipos financieros de price-source/support | INTEGRADA desde 046442a en este merge | 96 tests infra/docs re-corridos + typecheck/lint verdes; sin cambio de lógica |
| LM-env-hygiene | Exclusión del archivo real .env.test; cell/large-money-env-final | INTEGRADA desde 7a76046 en este merge | copia local preservada byte a byte y ahora ignorada; sólo ejemplo versionado; sin rewrite |

### Decisiones operativas

- Sin recortes de aceptación. Rutas disjuntas y worktree por célula, con npm ci offline y Prisma Client generado antes del dispatch.
- Sólo PostgreSQL de test aislado. LM-B tiene bases prefijadas `lm_b_`; las suites de integración finales usarán el cluster efímero, nunca el destino de la app.
- La firma D5 permite personalizar la migración nueva aún no aplicada; no editar la inicial ni usar db push.
- La preparación no actualiza dependencias: Node 26.12.1, npm 12.0.2 y Prisma 7.10.1 verificados. Avisos de npm sobre dependencias no se consideran una auditoría completa de seguridad.

### Reanudación y ownership T13/T14

- Base de reanudación ee5703f; se integraron C0, B y E-docs. Gate de seams re-corrido: 4 suites / 50 tests (contratos + storage PG + CODEMAP). Esto NO es un gate de feature: typecheck/global y consumidores siguen pendientes.
- Última corrida global previa (46fcb36): 34 suites, 325/380 tests pasan; 55 fallos. Funcionales: 36/86 pasan. Probes en DB aislada reprodujeron 123.45 → 123, 0.01 → ZERO_SIZE y falsa equivalencia idempotente 123.01/123.99. No integrar ese comportamiento a main.
- LM-C1-pure: src/domain/{portfolio,sizing,matching}/index.ts, src/domain/{index.ts,ports/index.ts}; tests/unit/domain/{helpers.ts,portfolio.test.ts,portfolio-characterization.test.ts,portfolio-total-account-value.test.ts,sizing.test.ts,matching.test.ts}. CODEMAP sólo filas dominio/ports.
- LM-D-final: src/infra/prisma/{mappers,order-repository,portfolio-read-repository,marketdata-repository,marketdata-price-source}.ts; tests/unit/infra/mappers-filled-price.test.ts; tests/integration/infra/{support,portfolio-read-repository.test,order-repository.create-order.test,order-repository.idempotency.test,order-repository.transaction.test,marketdata-repository.test}.ts; tests/helpers/factories.ts. Puede extraer helpers de infra si lint lo exige y registrar CODEMAP sólo sus filas.
- LM-E-wire-final: scripts/openapi/{wire,registry,build}.ts, scripts/generate-openapi.ts, openapi.json, tests/docs/openapi.test.ts; CODEMAP sólo filas de herramientas.
- LM-C1-app (después de pure): src/application/**, src/http/{shared/edge,portfolio/portfolio-router,orders/orders-router,transfers/transfers-router,instruments/instruments-router}.ts, tests/unit/{application,http}/**, tests/helpers/fakes/submit-order-fakes.ts; CODEMAP sólo application/HTTP.
- LM-E-functional (después de código estable): tests/functional/**, con inventario y cortes de máximo 2 archivos por adaptación. Nuevas suites de aceptación con DB propia; sin colisión con integración.
- Ninguna célula cambia specs, DECISIONS, deps, migraciones aplicadas, DB app o main. Nuevos archivos de src sólo para extraer funciones financieras por umbral de lint, sin ampliar diseño; CODEMAP en el mismo commit. Los cambios compartidos se integran secuencialmente.

### Auditoría de integración (GLM, revisada por el orquestador)

- Verificado: main 60b3764 es ancestro de feature; las 26 rutas del snapshot b8006af coinciden byte a byte con el árbol original, sin drift. La rama de instrumentos NO es ancestro. Esto habilita un fast-forward de commits, no garantiza ausencia de obstáculos en un worktree sucio.
- Preservar el índice original: `.env.test` tiene eliminación staged en main pero sigue rastreado en el snapshot/feature. El cierre debe excluirlo del árbol versionado sin perder su copia local; no leer ni imprimir contenido ni credenciales. La historia local ya existente no se reescribe sin permiso y no hay push autorizado.
- Se acepta respaldo recuperable antes del fast-forward; se rechaza asumir que `stash -u` preserva por sí solo el archivo local en todos los estados, o que eliminar `.env.test` del índice deja un diff vacío contra una feature que aún lo rastrea. Revalidar rutas, archivos ignorados y tip final antes de integrar. No aplicar stash automáticamente si sus cambios ya están incorporados.
- La migración de la DB de la app sigue FUERA de alcance. Los gates usan exclusivamente el cluster efímero de test; no equivalen a despliegue sobre el esquema viejo de la app.

### QUESTIONs activas

Ninguna. Si una decisión de diseño no está expresada en la spec firmada, detener esa parte y preguntar; no ampliar alcance.

### Revisión de la reanudación

- Dominio y OpenAPI aceptados: 3938ec0/3477ff9. Gate conjunto re-corrido: 7 suites / 79 tests (domain + docs), lint y diff-check verdes. Checkpoint global explícitamente rojo: 40 diagnósticos TypeScript en app/HTTP/infra/tests aún pendientes; no es cierre de feature.
- LM-D 8287dfa devuelve replay antes de leer evidencia cuando stored == requested. REJECT de revisión: histórico pedido 123.45, guardado 123, retry 123.00 debe ser conflicto; evidencia ausente o corrupta no se vuelve suficiente por igualdad de size. Se delegó TDD del caso y validación del evento origen para todo replay cash, reutilizando gramática de contracts (sin duplicación).
- LM-D revisión cerrada en 86dcbb4: evidencia obligatoria aun si stored == retry, schema monetario único, primer evento coherente FILLED/ACCEPTED o REJECTED/REJECTED; NEW/CANCELLED no justifican replay cash. Se acepta exigir evento a fixtures de repo porque la app lo escribe atómicamente. Errores app no generan ticket ajeno: pertenecen a la célula activa.
- Gate integrado dominio + infra + docs re-corrido: 15 suites / 196 tests verdes con PostgreSQL test real, lint/diff-check verdes. Checkpoint global aún rojo: 24 diagnósticos TypeScript, todos en app/HTTP y sus fakes/tests asignados a LM-C1-app. Main permanece sin tocar.
- LM-C1-app aceptada en 835699a: bases distributivas preservan unidades de draft, cash exacto sin sizing de acciones, quantity bigint interno/string HTTP, RangeError de sizing mapeado a400 sin writes (otros errores propagan). Se acepta omitir residualArs en eventos nuevos de cash porque ya no hay floor; amountArs canónico sigue siendo evidencia de origen.
- Gate del runtime integrado: typecheck + lint + build verdes; 29 suites / 403 tests unit/docs/integration verdes con PostgreSQL real. Las suites funcionales previas aún requieren adaptación y pruebas de aceptación nuevas: no afirmar cierre global ni ejecución final de colección.
- Probes del orquestador contra app compilada y DB nueva lm_diagnostic_test (2 migraciones + seed): CASH_IN123.45 persiste123.45 y responde size string; CASH_IN0.01 persiste0.01; misma key123.01→123.99 devuelve409. Portfolio final de esas pruebas cash246.47, exacto. Los3 defectos concretos iniciales ya no se reproducen; no sustituye el gate e2e completo.
- QA independiente sobre b55a8db: ACCEPT de runtime8.5/10, 82 tests puros re-corridos por revisor, sin bug de fuente confirmado. Se aceptan como pendientes las pruebas HTTP nuevas y concurrencia cash (células activas). Observación menor aceptada: CHECK size0 sólo acredita status REJECTED, no reason de evento; no se añadirá constraint cross-table. Importaciones de tipo price-source y constructor en soporte infra se alinean por T13. Downgrade DDL no prometido ni autorizado.
- T14 y aceptación cerradas: órdenes47, lectura/cancel/transfers42 y nuevos E2E19 re-corridos por el orquestador. Se acepta fixture cash con price1.00/size monto exacto y cuantización de presentación del SUM SQL en FinancialDecimal (sin tocar valores económicos ni ocultar resultados numéricos viejos).
- GATE COMPLETO de feature re-corrido con DBs recreadas: typecheck + lint + build + OpenAPI determinista verdes; npm test -- --runInBand --detectOpenHandles: **37 suites / 515 tests verdes**, openHandles=[] (despeja advertencia aislada anterior). Los2 logs de error HTTP corresponden a fallos de auditoría inyectados deliberadamente para probar rollback, no tests fallidos. Falta cierre documental y revisor del SHA final antes de integrar main.
- Límites de evidencia: quantity agregada >MAX_SAFE_INTEGER se probó en unit con órdenes INT4 válidas, no mediante millones de filas E2E; la migración y locks se ensayaron en DBs de test chicas, no en producción. Ninguna DB de app migrada ni push remoto realizado.
- Aceptadas las decisiones del dominio: builders cash/trading separados; cantidades acumuladas bigint probadas con órdenes INT4 válidas; matching conserva reglas y sigue sin disparador. No hay ampliación de diseño.

### Revisión intermedia del orquestador

- LM-A verificada sobre 607c138: 4 suites / 47 tests (incluye CODEMAP), build y lint verdes. Se devuelve para validar finitud también después de Number en serializePct y adaptar las dos operaciones monetarias de un test al string. El resto de consumidores se adapta en fases posteriores, no se afirma typecheck global verde.
- LM-B verificada sobre 11eb26d: 21 pruebas PostgreSQL reales; ALTER observado 95 ms en tabla chica. Se devuelve porque un CHECK debe tratar NULL explícitamente para que size=0 sólo permita REJECTED, y la suite no debe rechazar el nombre cocos_* del URL fuente global si sólo crea destinos propios lm_b_*.
- Resolución LM-A: no inventar prohibición de cero negativo en el schema firmado genérico de entrada; Positive lo rechaza y la salida lo normaliza. No requiere cambiar el diseño ni consultar un nuevo default.
- Seams de tipos se preparan en célula separada antes de paralelizar dominio/aplicación e infra; no se mezclan unidades mediante casts.
- Revisión LM-A cerrada en 462074f: overflow pct cubierto y typecheck recuperado. Commits integrados 51d5076/e676d90/3d20e69/1099fb4; 4 suites / 48 tests y typecheck/lint/build re-corridos por el orquestador. Gate de alcance, no final de feature: faltan consumidores del contrato incompatible.
- Revisión LM-B cerrada en afc5e5f: cero/status NULL rechazado y URL fuente global admitida sin DROP de esa base. 22 tests PG re-corridos (ALTER 95 ms en ensayo chico). Se espera integración con mappers para regenerar el cliente de la integradora; LM-D ya tiene cliente nuevo y base propia sin usar DB de app.

---

## Histórico del build inicial (cerrado; no describe las células LM)


## Estado actual

- **FASE 0** (Célula 0 — entorno): **DONE — merge `b590dfb`, GATE 0 verificado por el orquestador** (typecheck/lint/test verde, `test:db:reset` idempotente, Prisma CLI 7.10.1 = client 7.10.1).
- **FASE 1** (Célula 0 — contratos): **DONE — merge `86bc9c3`** (5 commits + corrección tx `bf4b992`). GATE 1 re-corrido por el orquestador: `prisma validate` + typecheck + lint + tests 4/4 + `test:db:reset` idempotente con columnas nuevas. `DECISIONS.md` verificado byte-exacto contra el reference.
- **FASE 2** (paralelo): **DONE — GATE 2 cerrado.** A merge `1f4bdba` (44 tests), B merge `54cdd40` (34 tests), C merge `1e27c94` (15 tests, golden values verificados por la célula contra la DB: 627500/125500/764256), D merge `18b16bd` (matriz roja — su DONE = typecheck+lint verde + 25 reds por 404-asserts). Todos los gates re-corridos por el orquestador. Post-B: `npm install` en main por `@prisma/adapter-pg` (TS2307). Composition root `server.ts` montando lectura (C) @ `9d2f6b8` + fix de imports `98a25fb` (commiteé con typecheck rojo — `&&` no frenó la cadena; lección: gate explícito antes de commit). Suite main: 12 suites → 89 passed + 25 reds (matriz D, esperados hasta FASE 3). Sanity vivo: portfolio 200/cash 627500/3 posiciones; search "pam"→PAMP; POST orders→404.
- **FASE 3** (Célula E — UC-3): **DONE — GATE 3 cerrado.** Merge `1233c66` + integración `bae8eed`: mapper `filledPrice ?? price` (seam B↔DECISIONS.md reportado por E, QUESTION opción A), router orders cableado en `server.ts`, `jest.config.js` con projects (la suite de D no setea `DATABASE_URL` y GATE 3 la corre sin modificarla → proyecto uc3-functional apunta a `cocos_challenge_ftest`, su misma DB de asserts). **Suite main: 13 suites / 134 tests — los 25 de D en verde SIN tocar un archivo suyo.** Decisiones de E aceptadas: LIMIT+amountArs dimensiona por límite (GTC no resuelve ref); NO_PRICE con amountArs persiste size 0; INSTRUMENT_NOT_FOUND → 404 (DECISIONS no fija status para instrumento inexistente; spec Rev.3 sugería 400 — documentar en README); replay REJECTED devuelve reason null; SELL valida contra posición FILLED − reservadas (BMA −10 ⇒ vendible negativo).
- **FASE 4** (F cancelar + G transferencias): **DONE — GATE 4 cerrado.** F merge `b915058` (cancelOrder: guard atómico `WHERE status='NEW'` dentro de `withUserTransaction`, 422 sin mutar, 404/400, doble DELETE concurrente ⇒ una 200 + una 422, liberación de reserva visible en portfolio — 11 tests). G merge `086dd89` (submitTransfer espejando E: transferencias = orders del instrumento ARS id 66 con `price=1.00, size=pesos` — convención del seed; CASH_OUT valida contra DISPONIBLE dentro de la tx; el caso clave 630000 < settled 753000 pero > disponible 627500 ⇒ REJECTED — 14 tests). Gates re-corridos por el orquestador en ambos worktrees (145/145 y 148/148). Cableado `server.ts` @ `8bbac23` ⇒ **GATE 4: 15 suites / 159 tests verde**. Sanity vivo de los 5 endpoints: portfolio 200 (cash 627500), search METR, POST LIMIT de user 2 sin cash ⇒ REJECTED (fondos), cancel de REJECTED ⇒ 422 (guard), transfer IN ⇒ FILLED, OUT excesiva ⇒ REJECTED.
- **FASE 5** (Célula H — docs y entrega): **DONE — GATE 5 cerrado por el orquestador como revisor independiente.** Merge `8f23a5c` (README con 27 decisiones documentadas, docs/database.md corregido legacy vs migrado, collection/ REST Client con un ejemplo por caso). GATE 5 (revisor distinto del autor, DB limpia nueva `cocos_challenge_gate5`): drop/create → `migrate deploy` → seed (4/66/11/126) → `test:db:reset` + **`npm test` 15 suites / 159 tests verde** → server vivo + requests reales: portfolio golden (627500/125500/764256), búsqueda, transfer CASH_IN FILLED, orden LIMIT GTC NEW, **replay idempotente (misma id 13)**, **409 con otra key=payload**, 404 orden inexistente, **DELETE NEW → 200 CANCELLED**, DELETE repetido → 422, reserva liberada visible en portfolio (user 2: reserved 9000→0, cash 50000). Lint 0 warnings (fix propio de la directiva sin uso en `src/index.ts`).

**DEFINICIÓN DE TERMINADO — VERIFICADA (2026-11-03):** `typecheck && lint && test` verde desde DB limpia ✓ · 5 endpoints cumplen DECISIONS.md ✓ (verificados en vivo) · matriz UC-3 completa (los 25 de la Célula D en verde sin editarlos) ✓ · README con "Supuestos y decisiones" (27) y "Evolución propuesta" (7) ✓ · cero decisiones sin documentar ✓.

### Decisiones firmadas por el orquestador en FASE 4 (para el README de H)

1. DELETE exitoso de cancelación ⇒ **200** con OrderResponse (201 es para creación; DECISIONS.md no fija el status).
2. Evento CANCELLED por usuario: reason null, metadata origen `USER`.
3. Transferencias: instrumento del cash resuelto por ticker `"ARS"` vía port (QUESTION de G, opción A).
4. size en transferencia REJECTED = monto pedido (no 0); ZERO_SIZE sub-peso ⇒ REJECTED persistida (rama agregada por G, testeada).

### Lecciones de FASE 2 (para merges de FASE 3+)

- Un merge que agrega dependencias (`@prisma/adapter-pg`) requiere `npm install` en main post-merge: el typecheck de main dio TS2307 hasta sincronizar node_modules (ya corregido, main en verde 10 suites / 74 tests).
- Worktrees nuevos (`npm ci`) necesitan `npx prisma generate` antes de que compile cualquier import de `@prisma/client` (factories lo usan). Correrlo con `DATABASE_URL=<placeholder válido> npx prisma generate` (no toca DB).
- DBs aisladas por suite (script `TEST_DB_NAME`): B→`cocos_challenge_test`, C→`cocos_challenge_read`, D→`cocos_challenge_ftest`. Cada suite se auto-resetea; ninguna pisa la de otra.

### Scaffolding del orquestador para FASE 2 (`5fbfbbc`)

- `jest.config.js`: `moduleNameMapper` `.js`→`.ts` (jest-resolve no mapea extensiones ESM).
- `src/http/app.ts`: `buildApp(routers)` — composición por inyección: cada slice exporta su Router factory con deps (ports) inyectadas; los tests componen localmente y nadie compite por un archivo compartido.
- `src/http/server.ts`: `serverApp = buildApp([])` — stub que responde 404 en todo, para que los tests rojos de D fallen por 404 y no por setup. La composición real la monta la célula integradora de cada fase.

### Interpretación firmada por el orquestador (derivada de DECISIONS.md, valida el modelo de reservas)

- Validación de fondos de BUY (MARKET y LIMIT) contra **cash disponible** (`cashSettled − cashReserved`), y de SELL contra **acciones vendibles** (`posición − reservadas`): las reservas son compromisos reales ("cash = cashSettled − cashReserved"; CASH_OUT valida contra lo disponible). El test de "dos órdenes simultáneas que juntas exceden el cash ⇒ una FILLED y una REJECTED" se escribe contra esta lectura.

### Interpretaciones DECISIONS fijadas en contrato por la Célula 0 (aceptadas por el orquestador)

- MARKET con `price` en el body => 400 (no crea orden).
- IOC/FOK sin precio de referencia => REJECTED persistida con `NO_PRICE`; GTC LIMIT sin precio => NEW (resting no necesita ref para nada); MARKET sin precio => REJECTED `NO_PRICE`.
- Búsqueda responde array plano (sin wrapper). Query vacía o ausente => 400.
- `timeInForce` NOT NULL DEFAULT 'GTC' en DB (toda orden conoce su TIF; seed queda en GTC; TIF se ignora para MARKET).
- `datetime`/`filledAt` serializan ISO 8601 **sin offset** (timestamp sin tz, hora local del mercado).
- Nombres estables de error codes: VALIDATION_ERROR, INSTRUMENT_NOT_OPERABLE, USER_NOT_FOUND, ORDER_NOT_FOUND, IDEMPOTENCY_CONFLICT, ORDER_NOT_CANCELLABLE.

### Notas de FASE 1 para las células de FASE 2

- `@prisma/adapter-pg` (driver adapter, EXIGIDO por Prisma 7 para instanciar el cliente): **aprobado por el orquestador** para la Célula B — es parte del stack Prisma ya elegido por el repo, no una decisión nueva de diseño.
- jest-resolve NO mapea `.js`→`.ts`: ANTES de lanzar FASE 2 el orquestador agrega `moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }` a `jest.config.js` (ruta del orquestador — las células no pueden tocar jest.config.js).
- Generador Prisma: `prisma-client-js` (emite `.js`+`.d.ts` a `node_modules/.prisma/client` — compatible con tsc nodenext + jest CJS + eslint sin tocar configs). El nuevo `prisma-client` solo emite `.ts` y rompería el lint.

### Decisiones aceptadas por el orquestador en FASE 0 (reportadas por la célula)

1. **TypeScript ^7.0.2 → ^5.9.3**: TS7 (compilador nativo) removió la API JS de `require('typescript')`; ts-jest y typescript-eslint dependen de ella. 5.9.3 es la única línea que satisface ambos peers pedidos por el plan. Reversible con bump de devDep.
2. **@types/pg@^8.23.1** (types-only): pg no bundlea tipos y el humo de DB usa pg bajo strict/no-any.
3. **npm allowScripts** aprobado para prisma + @prisma/engines (sin postinstall de ellos el CLI 7.x no baja binarios). esbuild y @parcel/watcher SIGUEN bloqueados → **limitación conocida**: `npm run dev` (tsx watch) puede fallar en FASE 3; los gates del plan no lo incluyen.

### Notas técnicas heredadas (de FASE 0, para las células siguientes)

- App ESM (`type: module`, tsconfig nodenext); tests compilados a CJS por ts-jest (`tsconfig.test.json`).
- `import { Decimal } from 'decimal.js'` (named) bajo nodenext — el default export del d.ts no tiene construct signature.
- Prisma 7 no autocarga `.env`: la URL del datasource se resuelve vía `prisma.config.ts` (`defineConfig` de `prisma/config`).
- `npm run build` compila también `tests/` (no hay rootDir): si FASE 3 quiere dist limpio, hace falta `tsconfig.build.json`.

## Referencia del seed

- User 1 (calculada contra el seed): cashSettled=753.000,00 · cashReserved=125.500,00 · **cashDisponible=627.500,00**.
- PAMP qty 40 (close 925,85 · 14-jul) · METR qty 500 (close 229,50) · BMA qty −10 (close 1.502,80).
- Sin marketdata (→ NO_PRICE): PGR, IRCP. ARS (id 66, MONEDA): no operable.
- `package.json` de partida con deuda conocida: prisma@8-rc (CLI de Platform, no ORM) vs
  @prisma/client@7.10.1 · postinstall ajeno (`prisma skills sync`) · `prisma:seed` apunta a
  `prisma/seed.ts` inexistente · `type: commonjs` vs ESM mandatorio en AGENTS.md.

## Células

| Célula | Fase | Estado | Gate |
|---|---|---|---|
| 0 — entorno | 0 | **DONE (merge `b590dfb`)** | GATE 0 ✓ |
| 0 — contratos | 1 | **DONE (merge `86bc9c3`)** | GATE 1 ✓ |
| A — dominio puro | 2 | **DONE (merge `1f4bdba`)** | GATE 2 ✓ |
| B — persistencia e infra | 2 | **DONE (merge `54cdd40`)** | GATE 2 ✓ |
| C — endpoints de lectura | 2 | **DONE (merge `1e27c94`)** | GATE 2 ✓ |
| D — tests funcionales UC-3 (rojos) | 2 | **DONE (merge `18b16bd`)** | GATE 2 ✓ |
| E — integración UC-3 | 3 | **DONE (merge `1233c66`)** | GATE 3 ✓ |
| F — cancelar orden | 4 | **DONE (merge `b915058`)** | GATE 4 ✓ |
| G — transferencias | 4 | **DONE (merge `086dd89`)** | GATE 4 ✓ |
| H — docs y entrega | 5 | **DONE (merge `8f23a7c`)** | GATE 5 ✓ |

## QUESTIONs abiertas

(ninguna)

## Limitaciones acumuladas (input del README de FASE 5)

- Alcance cerrado por DECISIONS.md: sin Yahoo, sin price_ticks/ingesta, sin DAY/EXPIRED,
  sin sweep, sin matching continuo, sin fills parciales, sin prioridad precio-tiempo
  → van a "Evolución propuesta" del README, no al código.
- Posición negativa del seed (BMA −10) se lista tal cual: inconsistencia del dataset,
  documentada, no "corregida" por el código.
- Las pruebas de integración usan el PostgreSQL configurado por `TEST_DATABASE_URL`, separado de
  `DATABASE_URL` runtime; puede ser local o administrado. No se asume proveedor, host ni puerto.
  `docker-compose.yml` queda como opción de entorno, no como requisito de la aplicación.
