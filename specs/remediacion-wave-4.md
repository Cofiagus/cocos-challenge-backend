# Spec — Wave 4: garantías de escritura y cierre de la deuda de cobertura

**Estado: BORRADOR Rev. 1 — ejecución autorizada por el humano (2026-11-06).**
**Continúa:** `specs/remediacion-revision-calidad.md`. **Base:** HEAD `6d39749`.

---

## 1. Why

Cerradas las Waves 1–3, quedaron tres deudas que la revisión dejó abiertas y que el preflight
demostró que **no son de datos**: medidas sobre el seed (11 órdenes) y sobre la DB de la app
(12 órdenes), las violaciones de las invariantes de escritura son **0** en todos los casos
salvo los 7 `FILLED` heredados sin `filledPrice` (que sí tienen `price`). Es decir: la razón por
la que esas invariantes no están en la DB es una **deuda de cobertura** — los tests caracterizan
el camino legacy insertando filas que las violan —, no una imposibilidad del dataset.

Esta wave las lleva al esquema sin perder esa cobertura, y cierra el último ruido del gate
(handles sin cerrar en la corrida paralela).

## 2. What (alcance)

Dos células, rutas disjuntas:

| Célula | Objetivo | Rutas que ESCRIBE |
|---|---|---|
| **F11-INVARIANTS** | La comparación idempotente pasa a ser una función pura testeable sin DB; con eso liberados los tests de integración, entran los CHECKs de escritura, más el backfill de los `FILLED` heredados y su CHECK estricto | `src/infra/prisma/request-comparison.ts` (nuevo), `src/infra/prisma/order-repository.ts`, `prisma/schema.prisma`, `prisma/migrations/<nueva>/migration.sql`, `tests/unit/infra/request-comparison.test.ts` (nuevo), `tests/integration/infra/order-repository.idempotency.test.ts`, `tests/integration/infra/order-repository.create-order.test.ts` |
| **F12-HANDLES** | Encontrar y cerrar el handle que hace que la corrida paralela termine con `A worker process has failed to exit gracefully` | `tests/functional/*/support.ts`, `tests/integration/infra/support.ts` (y el `afterAll` que corresponda) |

## 3. Constraints (qué NO)

1. **No editar migraciones aplicadas.** Migración nueva, create-only en su generación.
2. **No aplicar la migración a la DB de la app** (Q4=A): se versiona y se ensaya en una base
   aislada creada por la célula. La DB de la app exige la ventana coordinada, que no está abierta.
3. **No perder cobertura del camino legacy.** Los 5 casos que hoy insertan filas no conformes
   (`priceArs: null` en LIMIT, precio/instrumento cambiados en cash) se prueban en **unit** con
   filas construidas a mano, no desaparecen.
4. **No cambiar el comportamiento idempotente:** fila sin huella ⇒ comparación histórica; la
   política CONFLICT conservadora se mantiene.
5. **Sin `CHECK` con subconsulta.** `CASH ⇒ instrumentId = ARS` **no** es expresable como CHECK
   (PostgreSQL no admite subqueries en CHECK). Si la célula quiere garantizarlo, es con trigger —
   y esa opción está **descartada** por esta spec: añade una dependencia oculta a `instruments` y
   rompe la carga del seed. Queda como invariante de aplicación, documentada.
6. **Backfill acotado y auditable:** sólo `FILLED` con `filledPrice IS NULL`, tomando `price`,
   con evidencia de conservación (conteos y md5 antes/después).
7. Lo habitual: sin `any`, sin `eslint-disable`, sin subir umbrales, sin dependencias nuevas.

## 4. Tasks

### F11-INVARIANTS

- **T11.a — Extraer la comparación a módulo puro.** `src/infra/prisma/request-comparison.ts`
  expone la comparación de identidad del request (hoy privada en `sameIdentityPayload` /
  `sameTradingSize`, `order-repository.ts:102-118`) sobre un tipo de fila **estructural y propio**
  (no el tipo generado por Prisma), más la regla de huella con su fallback a comparación
  histórica. `order-repository.ts` pasa a consumirla: mismo comportamiento, sin duplicar.
- **T11.b — Cobertura en unit, sin DB.** `tests/unit/infra/request-comparison.test.ts` cubre con
  filas construidas a mano: fila sin huella + payload que difiere ⇒ CONFLICT; huellas iguales ⇒
  REPLAY; huellas distintas ⇒ CONFLICT; los casos legacy (LIMIT con `price` NULL, cash con precio
  o instrumento cambiados) ⇒ CONFLICT conservador. Con esto, `order-repository.create-order.test.ts`
  y `order-repository.idempotency.test.ts` dejan de necesitar insertar filas no conformes.
- **T11.c — Migración nueva** `db_write_invariants` (create-only), que agrega:
  1. `UPDATE orders SET "filledPrice" = price WHERE status = 'FILLED' AND "filledPrice" IS NULL;`
     (7 filas en seed y en la DB de la app; idempotente).
  2. `CHECK (type <> 'LIMIT' OR price IS NOT NULL)`.
  3. `CHECK (side NOT IN ('CASH_IN','CASH_OUT') OR price = 1.00)`.
  4. `CHECK (status <> 'FILLED' OR "filledPrice" IS NOT NULL)` — posible **después** del backfill.
  Actualizar `prisma/schema.prisma` en consecuencia.
- **T11.d — Ensayo en base aislada:** crear `cocos_f4_rehearsal`, aplicar las 4 migraciones,
  cargar `db/seed.sql` sin editarlo y verificar: conteos 4/66/11/126, md5 de `orders` y
  `marketdata` **idéntico** antes/después salvo la columna `filledPrice` backfilleada (documentar
  la diferencia esperada), y los golden del portfolio (cashSettled 753000.00, disponible 627500.00,
  reservado 125500.00, TAV 889756.00).

**VERIFY:** `npm run typecheck` · `npm run lint` · `npx prisma validate` ·
`npx jest tests/unit tests/integration/infra tests/docs` · ensayo con evidencia.

### F12-HANDLES

- **T12.a — Aislar el handle.** Correr `npm test -- --detectOpenHandles` y, si hace falta,
  suite por suite (`npx jest <suite> --detectOpenHandles`) hasta identificar cuál deja un cliente
  Prisma, un servidor o un timer vivo. Registrar el comando y la salida que lo prueba.
- **T12.b — Cerrarlo en el teardown** (`afterAll` / `afterAll` del support correspondiente), sin
  relajar aserciones ni desactivar la suite.
- **T12.c — Verificar que la corrida paralela termina limpia:** `npm test` sin el warning
  `A worker process has failed to exit gracefully`.

**VERIFY:** `npm run typecheck` · `npm run lint` · `npm test` (completo) sin el warning ·
`npx jest --runInBand --detectOpenHandles` limpio.

## 5. Fuera de alcance

- Aplicar la migración a la DB de la app (ventana coordinada, decisión humana aparte).
- Trigger para `CASH ⇒ instrumento = ARS` (descartado en §3.5).
- Eliminar el fallback `filledPrice ?? price` del mapper: sigue siendo necesario para filas
  previas al backfill mientras la migración no esté aplicada en todos los ambientes.
- Matching, fills parciales, auth, cambios de contrato.

## 6. Gate de la wave (lo corre el orquestador)

```bash
npm run typecheck && npm run lint      # exit 0
npm run test:db:reset && npm test      # 48+ suites en verde, sin el warning de handles
npx jest tests/docs                    # guardia normativa
```

Reglas: merge de a una célula por vez, re-corriendo el gate tras cada merge; worktree eliminado y
verificado tras integrar; `PROGRESS.md` actualizado en el mismo commit que cierra la wave.
