# PROGRESS.md — bitácora del orquestador

Solo el orquestador escribe este archivo. Fuente de verdad del avance: fases, gates,
estado por célula, QUESTIONs abiertas y limitaciones acumuladas para el README.

La tabla de Células y la línea de HEAD de la sección Entorno se actualizan en el MISMO
commit que cierra el gate. Si quedan atrás, una sesión que reanude lee estado falso: la
tabla de abajo decía «no lanzada» para A–G mientras el texto ya daba GATE 4 por cerrado.

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

## Entorno (verificado 2026-11-03 por el orquestador)

- Repo: `/home/cofi/repos/cocos-challenge-backend`, branch `main` (hash real: `git log -1 --oneline` — este archivo se commitea después del gate y mueve HEAD).
- Node v26.12.1, npm 12.0.2. **Sin docker** en esta máquina.
- PostgreSQL 18 como cluster userspace: `~/.pg/cocos`, puerto 5433, user `postgres`,
  auth trust (`.env` ya apunta ahí). Socket dir: `/tmp` (arranque:
  `/usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o "-p 5433 -k /tmp" -l ~/.pg/cocos.log start`).
- DB dev `cocos_challenge` con snapshot `db/schema.sql` + `db/seed.sql` cargado y verificado:
  users=4, instruments=66, orders=11, marketdata=126.
- Referencia user 1 (calculada contra el seed, no de memoria):
  cashSettled=753.000,00 · cashReserved=125.500,00 · **cashDisponible=627.500,00**
  PAMP qty 40 (close 925,85 · 14-jul) · METR qty 500 (close 229,50) · BMA qty −10 (close 1.502,80)
  Sin marketdata (→ NO_PRICE): PGR, IRCP. ARS (id 66, MONEDA): no operable.
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
| H — docs y entrega | 5 | EN CURSO (wt-h) | GATE 5 pendiente |

## QUESTIONs abiertas

(ninguna)

## Limitaciones acumuladas (input del README de FASE 5)

- Alcance cerrado por DECISIONS.md: sin Yahoo, sin price_ticks/ingesta, sin DAY/EXPIRED,
  sin sweep, sin matching continuo, sin fills parciales, sin prioridad precio-tiempo
  → van a "Evolución propuesta" del README, no al código.
- Posición negativa del seed (BMA −10) se lista tal cual: inconsistencia del dataset,
  documentada, no "corregida" por el código.
- Sin docker en la máquina de desarrollo: DB local = cluster userspace PG 18 en 5433;
  `docker-compose.yml` queda como referencia para otros entornos.
