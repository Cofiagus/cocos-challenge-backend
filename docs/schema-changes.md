# Cambios al esquema de la base de datos

> **Qué es este documento.** El challenge entregó un esquema funcional de cuatro tablas
> (`users`, `instruments`, `orders`, `marketdata`) y autorizó explícitamente a
> *"modificar, agregar o ajustar tablas según lo considere necesario"*, con la condición de
> **justificar adecuadamente cualquier cambio en la documentación**. Este documento registra cada
> cambio, su motivo y la decisión de la que se deriva.

## Resumen

| | |
|---|---|
| Tablas provistas conservadas | 4 (`users` · `instruments` · `orders` · `marketdata`) |
| Tablas **modificadas** | 2 (`orders` · `marketdata`) |
| Tablas **nuevas** | 1 (`order_events`) |
| Columnas nuevas | 6 en `orders` |
| Tipos ensanchados de `NUMERIC(10,2)` a `NUMERIC(24,2)` | 8 |
| `varchar` convertidos a `enum` | 3 |
| `CHECK` constraints agregados | **10** |
| Índices agregados | 6 |
| Triggers agregados | 1 |

**Nada se eliminó ni se renombró.** El esquema provisto se conserva y se extiende; ninguna
columna existente cambió de nombre ni desapareció.

---

## 1. `orders` — anchado de tipos y nuevas columnas

| Columna | Provisto | Actual | Motivo |
|---|---|---|---|
| `id` | `integer` PK | `integer` PK | sin cambios |
| `instrumentid` | `integer` NULL FK | igual | se mantiene nullable por las filas legacy del seed |
| `userid` | `integer` NULL FK | igual | idem |
| `size` | **`integer`** | **`NUMERIC(24,2)`** | Ver abajo |
| `price` | `NUMERIC(10,2)` | **`NUMERIC(24,2)`** | grandes montos (**D1**) |
| `type` | `varchar(10)` | **`enum "OrderType"`** | Valor inválido imposible en la DB |
| `side` | `varchar(10)` | **`enum "OrderSide"`** | idem; **D4** añade `CASH_IN`/`CASH_OUT` |
| `status` | `varchar(20)` | **`enum "OrderStatus"`** | idem |
| `datetime` | `timestamp` NULL | **`timestamp` NOT NULL** | una orden sin instante no es auditable |
| `timeInForce` | — | **enum NOT NULL DEFAULT 'GTC'** | GTC / IOC / FOK exigen persistir el TIF (**D3**) |
| `filledPrice` | — | **NUMERIC(24,2) NULL** | `price` = límite enviado · `filledPrice` = ejecución (**D3**) |
| `filledAt` | — | **timestamp NULL** | cuándo ocurrió la ejecución |
| `idempotencyKey` | — | **TEXT NULL + UNIQUE(userid, key)** | idempotencia en la DB, no en memoria (**D5**) |
| `requestFingerprint` | — | **TEXT NULL** | detectar misma key con distinto payload ⇒ 409 (**D5**) |

### ¿Por qué `size` dejó de ser `integer`?

El challenge pide dos cosas que chocan:

1. *"enviar la **cantidad de acciones** que quiere comprar o vender"* → entero.
2. *"o un **monto total de inversión en pesos**"* → dinero, **con centavos**.

Una sola columna, dos unidades. `integer` no puede guardar `123.45`. De ahí `NUMERIC(24,2)`.

Para que eso no abra la puerta a *"acciones con fracciones"* —que el challenge prohíbe— hay dos barras:
- en la aplicación: `sizeSharesFromAmountArs` hace `floor` en Decimal y valida el rango INT4 antes de convertir a `number`;
- en la base: `orders_share_size_int4_check` impide fracciones (y desbordes de INT4) en `BUY`/`SELL`.

**Precisión:** `NUMERIC(24,2)` admite hasta 22 dígitos enteros — muy por encima de los ~15–17 que soporta un `number` de JavaScript sin redondear. Es el ancho que soporta los montos grandes del challenge.

---

## 2. `marketdata` — anchado y constraints

| Elemento | Provisto | Actual | Motivo |
|---|---|---|---|
| `high` / `low` / `open` / `close` / `previousClose` | `NUMERIC(10,2)` | `NUMERIC(24,2)` | grandes montos (**D1**) |
| `instrumentid` / `date` / `close` / `previousclose` | NULL | **NOT NULL** | no hay vela sin instrumento ni fecha |
| `UNIQUE (instrumentid, date)` | — | ✔ | una sola vela por instrumento y día |
| `marketdata_prices_finite_non_negative_check` | — | ✔ | precios finitos y no negativos |

---

## 3. `order_events` — tabla nueva

| Columna | Tipo | Motivo |
|---|---|---|
| `id` | `integer` PK | — |
| `orderid` | `integer` NOT NULL FK → `orders(id)` | todo evento pertenece a una orden |
| `eventType` | enum `OrderEventType` | ACCEPTED / REJECTED / FILLED / CANCELLED |
| `reason` | enum `OrderEventReason` NULL | INSUFFICIENT_FUNDS · INSUFFICIENT_POSITION · ZERO_SIZE · NO_PRICE · NO_IMMEDIATE_MATCH |
| `metadata` | `jsonb` NULL | evidencia para reconciliar (p. ej. monto original de cash) |
| `createdAt` | `timestamp` NOT NULL | cuándo ocurrió |

**Por qué es necesaria:** el desafío exige órdenes persistentes con estado, y además *"actualizar el listado de posiciones"* al ejecutarse. Sin un registro append-only de transiciones no hay forma de auditar cómo una orden pasó de `NEW` a `FILLED`, ni detectar un replay con payload distinto. Es la bitácora del dominio.

Índice: `order_events_orderid_idx` (reconstruir la historia de una orden).

---

## 4. Integridad agregada

### 10 `CHECK` financieros

| # | Constraint | Qué garantiza |
|---|---|---|
| 1 | `orders_price_finite_positive_check` | precio finito y > 0 |
| 2 | `orders_filledprice_finite_positive_check` | precio de ejecución finito y > 0 |
| 3 | `orders_size_finite_non_negative_check` | `size` finito y ≥ 0 |
| 4 | `orders_size_zero_only_rejected_check` | `size = 0` sólo en `REJECTED` |
| 5 | `orders_share_size_int4_check` | en `BUY`/`SELL` el tamaño es entero ≤ INT4 (prohíbe fracciones) |
| 6 | `marketdata_prices_finite_non_negative_check` | precios de mercado finitos y ≥ 0 |
| 7 | `orders_filled_requires_execution_price_check` | toda `FILLED` tiene precio de ejecución |
| 8 | `orders_limit_requires_price_check` | `LIMIT` exige precio |
| 9 | `orders_cash_price_unit_check` | cash usa precio unitario 1.00 |
| 10 | `orders_filled_requires_filledprice_check` | `FILLED` implica `filledPrice` |

### Unicidades

| Unicidad | Motivo |
|---|---|
| `orders(userid, idempotencyKey)` | **D5**: idempotencia garantizada por la DB |
| `marketdata(instrumentid, date)` | una vela por instrumento y día |

### Trigger de normalización

`orders_fill_execution_price_trigger` (**BEFORE INSERT OR UPDATE** de `status` · `price` · `filledPrice`)
copia `price` → `filledPrice` cuando la orden se ejecuta sin precio de ejecución explícito.
Evita órdenes `FILLED` sin precio y mantiene coherente la proyección de posiciones.

---

## 5. Lo que se conserva sin cambios

- **`users`** — sin cambios: no aporta nada al dominio exigido.
- **`instruments`** — sin cambios de columnas.
- **Todo nombre de tabla o columna existente** se conserva; sólo se agregaron columnas y constraints, y se ensancharon tipos numéricos.

---

## 6. Aplicación y verificación

```bash
# base de destino (local o remota) en DATABASE_URL
cp .env.example .env       # completar el placeholder

# esquema migrado
set -a && . ./.env && set +a && npx prisma migrate deploy

# dataset del challenge
psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -q -f db/seed.sql
```

Comprobación del estado aplicado:

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations ORDER BY started_at;
-- → 4 filas, todas con finished_at NOT NULL y rolled_back_at NULL

SELECT conname FROM pg_constraint WHERE contype = 'c' ORDER BY 1;
-- → 10 CHECKs financieros

SELECT tgname FROM pg_trigger WHERE NOT tgisinternal;
-- → orders_fill_execution_price_trigger
```
