# Legacy y artefactos históricos

> **Normativo en un solo sentido**: declara qué NO es fuente de verdad y qué usar en su lugar.
> Todo lo listado acá sigue en el repo a propósito (es evidencia del proceso o entrada de
> herramientas), pero **no se lee para saber cómo funciona el código**.

| Artefacto | Estado | Por qué no es fuente | Usar en su lugar |
|---|---|---|---|
| `db/schema.sql` | **generado y desactualizado** | Es el snapshot del dataset original; no tiene `timeInForce`, `filledPrice`, `filledAt`, `idempotencyKey`, `requestFingerprint` ni `order_events`. Cargarlo crea una base que no coincide con el código. | `prisma/migrations/**` (DDL real) + `db/seed.sql` (datos) |
| `db/indexes.sql` | **propuesta no aplicada** | Índices y CHECKs que se evaluaron y no entraron como tales: varios índices ya existen en el head con otro nombre (`marketdata_instrumentid_date_idx`, `orders_userid_status_idx`, `orders_userid_idempotencyKey_key`), y los CHECKs vigentes son los 10 de `docs/database.md` §10. | `prisma/schema.prisma` + `prisma/migrations/**` (fuente única de índices y constraints) |
| `PROGRESS.md` | **histórico** | Bitácora del build por fases/células; su tabla de estado quedó desactualizada. | `git log` + `docs/CODEMAP.md` |
| `specs/trading-api-domain.md` | **fuente del dominio, no del código** | Define UC-1..UC-5 y sus invariantes; describe también fuentes de precio y matching que el build cerró. | `docs/CODEMAP.md` (estado) · `docs/api.md` (cable) · `DECISIONS.md` (decisiones) |
| `specs/plan-mejoras-db.md` | **parcialmente implementado** | Plan de M1–M3: M3 se hizo, M1 se resolvió con `Decimal`, M2 no se aplicó. | `docs/CODEMAP.md` §Deuda |
| `specs/agentificacion-docs.md` | **spec vigente de la documentación** | — (se lee como plan, no como descripción del código) | — |
| `docs/arquitectura-componentes.html` | **estado objetivo, no implementado** | Dibuja cron de rueda, `price_ticks`, sweep de `DAY` y matching continuo: nada de eso existe. De Yahoo sólo existe el adaptador de cotizaciones de UC-2 (reapertura exclusiva, spec `specs/instruments-current-quotes.md` Rev. 2), con tests, compuesto en `http/server.ts` y **verificado en vivo** en G5: `GET /api/instruments?limit=100` devolvió 61/65 acciones con precio real y los 4 faltantes dieron 404 (ver `docs/api.md` §2). | `docs/arquitectura-implementada.html` |
| `docs/references/**` | **evidencia externa** | Investigación y fuentes de mercado; cita estructuras de otros proyectos. | — |
| `collection/*.http` | **ejemplos ejecutables** | Sirven para probar a mano; no son el contrato. | `openapi.json` (contrato) · `docs/api.md` (semántica) |
| `README.md` §Supuestos | **explicación** | Explica el porqué de cada decisión; la lista normativa es otra. | `DECISIONS.md` |
| `src/infra/prisma/marketdata-price-source.ts` · `matchRestingOrders` | **código sin cablear** | Implementan piezas del matching de evolución; ningún flujo de producción las llama (tienen tests). | — (punto de enchufe documentado en `docs/CODEMAP.md` §Deuda) |

## Reglas

1. Si vas a **levantar la base**: migraciones + `db/seed.sql`. Nunca `db/schema.sql`.
2. Si buscás **cómo funciona hoy**: `docs/CODEMAP.md` → `docs/api.md` / `DECISIONS.md`.
3. Si un documento histórico contradice al código, **gana el código** y el commit corrige el doc.
4. Lo histórico no se borra: se etiqueta. Borrarlo destruye la evidencia de por qué el código es así.
