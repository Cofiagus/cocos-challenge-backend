# Base de datos — esquema y guía de trabajo

PostgreSQL compatible con el esquema migrado · esquema `public` · dataset de referencia del challenge

Este documento describe **qué hay en la base** y **cómo iterar contra ella sin perder tiempo**.
Si algo cambia en la base, se regenera el snapshot con `make db-snapshot` (ver §6).

> ⚠️ **Snapshot legacy vs head versionado.** Este documento describe el **snapshot generado**
> (`db/schema.sql` + `db/seed.sql`), que es la fuente de los DATOS del challenge. El **esquema con
> el que corre la app** es el **head versionado**: `prisma/schema.prisma` + `prisma/migrations/**`,
> que agrega a `orders` las columnas
> `"timeInForce"`, `filledPrice`, `filledAt`, `idempotencyKey`, `requestFingerprint` y crea la tabla
> `order_events` (auditoría). El seed carga **sin ediciones** sobre el esquema migrado (las filas
> viejas quedan en `GTC`; el trigger de normalización de §10 copia `price` a `filledPrice`).
> Encima del legacy el head agrega 10 CHECK constraints y el trigger
> `orders_fill_execution_price_trigger`: el inventario completo de las **4 migraciones** está en §10.
> Para levantar una base de la app: `npx prisma migrate deploy` + `psql -f db/seed.sql` — **no**
> `make db-load LEGACY=1` (ese aplica el snapshot legacy). Ver §2 y §6.

> ⚠️ **Grandes montos (spec aprobada, D1–D5).** El **head versionado** (`prisma/schema.prisma` +
> migración `20261105104903_large_money`) declara `NUMERIC(24,2)` en los campos financieros:
> `orders.price`, `orders.filledPrice`, `orders.size` y los 5 precios de `marketdata`. Los IDs, FKs
> y secuencias **quedan INTEGER** (sin UUID ni BIGINT de identificadores). Que el head esté aplicado
> sobre una base concreta se verifica con `npx prisma migrate status` (§10); este documento describe
> los tipos y CHECKs del head, no el estado de una base en particular. La ventana de despliegue y
> sus condiciones están en la decisión D5 de `DECISIONS.md`.

> 🧭 **Convención de tipos monetarios — todo tipo citado declara su ALCANCE.** Un `numeric(p,s)` sin
> alcance es una afirmación ambigua: el mismo campo tiene tipos distintos según qué se esté mirando.
>
> | Alcance | Fuente de verdad | Campos financieros |
> | --- | --- | --- |
> | **snapshot legacy** (datos de referencia del challenge) | `db/schema.sql` (generado) | `numeric(10,2)` |
> | **head versionado** (lo que produce `npx prisma migrate deploy`) | `prisma/schema.prisma` + `prisma/migrations/**` | `numeric(24,2)` |
>
> La regla es mecánica: `numeric(10,2)` sólo puede citarse como **snapshot legacy** (dentro del bloque
> o la frase que lo rotula); el tipo del **head** es el que declara `prisma/schema.prisma`, así que un
> cambio de schema obliga a actualizar este documento en el mismo commit. `tests/docs/docs-consistency.test.ts`
> (D6) hace cumplir esta convención derivando los tipos del head desde `prisma/schema.prisma`.

### `db/schema.sql` es un snapshot generado — no cargar la base desde ahí

`db/schema.sql` es un volcado **viejo y generado** del esquema original del challenge: le faltan la
tabla `order_events`, las columnas `timeInForce`/`filledPrice`/`filledAt`/`idempotencyKey` y los
tipos del head. La única forma de crear o actualizar el esquema es `npx prisma migrate deploy` (más
`db/seed.sql` para los datos). **Nunca** cargues una base con `psql -f db/schema.sql` ni con
`make db-load LEGACY=1`: produce un esquema que la aplicación no puede usar. El snapshot se conserva
sólo como referencia de los datos de origen.

---

## 1. Panorama

El **snapshot legacy** (`db/schema.sql`) tiene cuatro tablas, sin vistas, sin funciones, sin
triggers, sin enums y sin CHECK constraints. El **esquema migrado** (`prisma/migrations/**`)
agrega `order_events` (cinco tablas) y seis enums nativos (`OrderType`, `OrderSide`,
`OrderStatus`, `TimeInForce`, `OrderEventType` y `OrderEventReason`), más los índices de §5,
las diez CHECK constraints y el trigger de §10.

```
users ──┐
        ├──< orders >── instruments ──< marketdata
        └───────────────┘
```

| Tabla         | Filas | Rol                                                          |
| ------------- | ----: | ------------------------------------------------------------ |
| `users`       |     4 | Titulares de cuenta                                          |
| `instruments` |    66 | Catálogo de instrumentos (65 acciones + 1 moneda: ARS)        |
| `orders`      |    11 | **Libro de movimientos**: órdenes de mercado y movimientos de cash |
| `marketdata`  |   126 | OHLC diario por instrumento (63 instrumentos × 2 fechas)      |

> **No existe tabla de `cash` ni de `positions`.** Ambos son **proyecciones de `orders`**.
> Ese es el eje de todo el diseño: el backend no "actualiza saldos", los deriva.

---

## 2. Tablas en detalle

### `users`

| Columna         | Tipo           | Nulo | Default            |
| --------------- | -------------- | ---- | ------------------ |
| `id`            | `integer`      | NO   | `nextval(users_id_seq)` |
| `email`         | `varchar(255)` | sí   | —                  |
| `accountnumber` | `varchar(20)`  | sí   | —                  |

Sin `UNIQUE` en `email`. Datos: `emiliano@`, `jose@`, `francisco@`, `juan@test.com` (ids 1-4).

### `instruments`

| Columna  | Tipo           | Nulo | Default                     |
| -------- | -------------- | ---- | --------------------------- |
| `id`     | `integer`      | NO   | `nextval(instruments_id_seq)` |
| `ticker` | `varchar(10)`  | sí   | —                           |
| `name`   | `varchar(255)` | sí   | —                           |
| `type`   | `varchar(10)`  | sí   | —                           |

Sin `UNIQUE` en `ticker`. Valores de `type`: `ACCIONES` (65) y `MONEDA` (1).

- **`ARS` = id 66, type `MONEDA`, precio 1.00.** Es el instrumento con el que se mueve el cash.
  Cualquier lógica de portfolio tiene que excluirlo de las posiciones.

### `marketdata`

| Columna         | Tipo (snapshot legacy) | Nulo |
| --------------- | ------------- | ---- |
| `id`            | `integer`     | NO   |
| `instrumentid`  | `integer`     | sí → `instruments(id)` |
| `high`          | `numeric(10,2)` | sí |
| `low`           | `numeric(10,2)` | sí |
| `open`          | `numeric(10,2)` | sí |
| `close`         | `numeric(10,2)` | sí |
| `previousclose` | `numeric(10,2)` | sí |
| `date`          | `date`        | sí   |

Cobertura real: **solo 2023-07-13 y 2023-07-14**, 63 de los 66 instrumentos.
Sin filas: `PGR` (id 3), `IRCP` (id 10) y `ARS` (id 66).

El **snapshot legacy** no tiene `UNIQUE (instrumentid, date)`: nada impide duplicar una vela. El
**head versionado** sí lo tiene — el índice único `marketdata_instrumentid_date_key`
(migración `20261106154910_db_integrity_constraints`, §10) — y además exige
`instrumentid`, `date`, `close` y `previousclose` **NOT NULL** (`high`/`low`/`open` siguen
nullable: el seed trae velas sin ellos).

Los cinco precios son `numeric(10,2)` en el **snapshot legacy** y `numeric(24,2)` en el **head
versionado** (`prisma/migrations/20261105104903_large_money`), que conserva nombres y mapeos; la
nullabilidad de `close`/`previousclose` la endurece después la migración
`20261106154910_db_integrity_constraints` (§10).

### `orders`

Tipos del **snapshot legacy**; en el esquema migrado `type`/`side`/`status` son enums nativos
(`OrderType`, `OrderSide`, `OrderStatus`) y `idempotencyKey` es `text`. El **head versionado**
además pone `type`, `side` y `datetime` **NOT NULL**; `status` sigue nullable (§10).

| Columna        | Tipo (snapshot legacy)     | Nulo | Notas |
| -------------- | -------------------------- | ---- | ----- |
| `id`           | `integer`                  | NO   | |
| `instrumentid` | `integer`                  | sí   | → `instruments(id)` |
| `userid`       | `integer`                  | sí   | → `users(id)` |
| `size`         | `integer`                  | sí   | cantidad (entera, nunca fraccionaria) |
| `price`        | `numeric(10,2)`            | sí   | **límite enviado** (`LIMIT`); `null` en `MARKET` creado por la app |
| `type`         | `varchar(10)`              | sí   | `MARKET` \| `LIMIT`; enum `OrderType` en el migrado |
| `side`         | `varchar(10)`              | sí   | `BUY` \| `SELL` \| `CASH_IN` \| `CASH_OUT`; enum `OrderSide` en el migrado |
| `status`       | `varchar(20)`              | sí   | `NEW` \| `FILLED` \| `CANCELLED` \| `REJECTED`; enum `OrderStatus` en el migrado |
| `datetime`     | `timestamp` (sin tz)       | sí   | `timestamp without time zone`: **se lee como UTC** (el proceso fija `TZ=UTC`) |

**Columnas del esquema MIGRADO** (no están en el snapshot legacy — `prisma/migrations/**`; los tipos
son los del head versionado):

| Columna         | Tipo (head versionado) | Nulo | Default | Notas |
| --------------- | ----------- | ---- | ------- | ----- |
| `"timeInForce"` | `TimeInForce` (enum) | NO | `'GTC'` | toda orden conoce su TIF; las filas del seed quedan en `GTC`; se ignora para `MARKET` |
| `filledPrice`   | `numeric(24,2)` | sí | — | **precio de ejecución** si `FILLED`; `NULL` si no ejecutó |
| `filledAt`      | `timestamp(6)` | sí | — | cuándo ejecutó |
| `idempotencyKey` | `text` | sí | — | claim idempotente; `UNIQUE(userid, idempotencyKey)` (múltiples `NULL` permitidos) |
| `requestFingerprint` | `text` | sí | — | huella del payload canónico para **comparar** en la idempotencia; **sin** `UNIQUE` (dos órdenes legítimas del mismo usuario con el mismo payload deben coexistir) |

Y la tabla nueva de **auditoría append-only**:

```
order_events(id, orderid → orders(id), eventType, reason NULL, metadata jsonb NULL, createdAt)
-- eventType: ACCEPTED | REJECTED | FILLED | CANCELLED
-- reason:    INSUFFICIENT_FUNDS | INSUFFICIENT_POSITION | ZERO_SIZE | NO_PRICE | NO_IMMEDIATE_MATCH
-- índice: order_events(orderid)
```

> **`price` vs `filledPrice` — la decisión del build.** `price` = **límite enviado** (`null` en un
> `MARKET` de la app, que no lleva límite); `filledPrice` = **precio de ejecución**. Así el límite
> original **no se pierde** al llenar la orden.
>
> **El caso legacy:** las filas `FILLED` del seed fueron copiadas del dataset original, que tenía
> una sola columna `price` con el precio de ejecución. En el archivo `db/seed.sql` esas filas
> llevan la ejecución en `price` y **no** traen `filledPrice` (la columna no existe en el snapshot
> legacy), así que entran con `NULL`. El head versionado no las deja así: la migración
> `20261106180000_db_write_invariants` hace el backfill `filledPrice = price` y deja un trigger que
> aplica la misma regla a toda escritura (§10). El mapper de lectura igual aplica
> `filledPrice ?? price`, de modo que la ejecución se lee correcta por ambos caminos.

Combinaciones presentes en el seed (11 órdenes, todas del user 1):

| side      | type     | status      | n |
| --------- | -------- | ----------- | -: |
| BUY       | LIMIT    | NEW         | 2 |
| BUY       | LIMIT    | FILLED      | 1 |
| BUY       | LIMIT    | CANCELLED   | 1 |
| BUY       | MARKET   | FILLED      | 2 |
| SELL      | MARKET   | FILLED      | 2 |
| SELL      | MARKET   | REJECTED    | 1 |
| CASH_IN   | MARKET   | FILLED      | 1 |
| CASH_OUT  | MARKET   | FILLED      | 1 |

`datetime` es `timestamp without time zone` y **se lee como UTC**: `@prisma/adapter-pg`
interpreta la columna sin zona como UTC y el proceso fija `TZ=UTC` (`src/index.ts`) para
que la serialización no se desplace según la zona del host. El seed guarda 2023-07-12 y
2023-07-13, entre 12:11 y 16:11.

**Unidades en `size` (grandes montos):** físicamente una sola columna `numeric(24,2)`, dos unidades
según `side` — en `BUY`/`SELL` es **cantidad de acciones enteras** (por orden 1..2147483647; `0`
sólo en `REJECTED`), en `CASH_IN`/`CASH_OUT` es el **monto en pesos con centavos** (nuevas
transferencias > 0, hasta el máximo D1). El valor `0` en cash queda reservado a los `REJECTED`
históricos de `ZERO_SIZE`; una transferencia nueva nunca lo produce.

---

## 3. Cómo se derivan cash y posiciones

Regla que reproduce exactamente el seed verificado:

```sql
-- CASH de un usuario
SELECT sum(CASE side
             WHEN 'CASH_IN'  THEN  size * coalesce("filledPrice", price)
             WHEN 'SELL'     THEN  size * coalesce("filledPrice", price)
             WHEN 'CASH_OUT' THEN -size * coalesce("filledPrice", price)
             WHEN 'BUY'      THEN -size * coalesce("filledPrice", price)
           END) AS cash
FROM   orders
WHERE  userid = $1 AND status = 'FILLED';
```

```sql
-- POSICIONES de un usuario
SELECT o.instrumentid, i.ticker,
       sum(CASE o.side WHEN 'BUY' THEN o.size ELSE -o.size END) AS quantity,
       sum(CASE WHEN o.side='BUY' THEN o.size*coalesce(o."filledPrice", o.price) ELSE 0 END)
         / nullif(sum(CASE WHEN o.side='BUY' THEN o.size ELSE 0 END), 0) AS avg_price
FROM   orders o
JOIN   instruments i ON i.id = o.instrumentid
WHERE  o.userid = $1 AND o.status = 'FILLED' AND o.side IN ('BUY','SELL')
GROUP  BY 1, 2
HAVING sum(CASE o.side WHEN 'BUY' THEN o.size ELSE -o.size END) <> 0;
```

Resultado verificado con el seed (user 1):

| Concepto           | Valor                        |
| ------------------ | ---------------------------- |
| Cash settled       | 753.000,00                   |
| Cash reservado     | 125.500,00 (LOMA 35.500 + BMA 90.000, ambas `NEW`) |
| **Cash disponible** | **627.500,00** = settled − reservado |
| PAMP               | 40 @ 930,00 → 37.034 (mark 925,85) |
| METR               | 500 @ 250,00 → 114.750 (mark 229,50) |
| BMA                | **−10** @ 1.540,00 → −15.028 ⚠️ |

Las dos queries usan `coalesce("filledPrice", price)` porque la API guarda el precio de
ejecución en `filledPrice` (y en `price` el límite, o `NULL` en `MARKET`); en el archivo del seed
las filas legacy lo tienen sólo en `price`, aunque al cargarlo sobre el head el trigger de §10
copia `price` a `filledPrice`. Los números de esta sección no cambian: el `COALESCE` da el mismo
resultado con `filledPrice` poblado o `NULL`.

Tras la migración de grandes montos estas queries no cambian: operan sobre `numeric(24,2)` y
devuelven `numeric` exacto (la API serializa el dinero como string de 2 decimales; el SQL nunca
convierte plata a float).

`db/queries/portfolio.sql` reproduce exactamente estos números: se validó cargando
`db/schema.sql` + `db/seed.sql` en un PostgreSQL limpio y contrastando el resultado con los
valores de referencia de esta sección.

**Sólo `status = 'FILLED'` mueve plata.** `NEW` **reserva** (decisión del build): BUY `NEW`
reserva `limit × size` de cash y SELL `NEW` reserva `size` acciones — **sin tabla de reservas**,
se derivan de las `NEW` al vuelo:

```sql
-- RESERVAS de cash de un usuario (órdenes NEW de compra)
SELECT coalesce(sum(size * price), 0) AS cash_reserved
FROM   orders
WHERE  userid = $1 AND status = 'NEW' AND side = 'BUY';
```

La API reporta el cash **disponible** y el reservado **por separado** (`cash` = settled −
reservado, `reservedCash`): los valores de referencia verificados contra la API son
`cash = 627.500`, `reservedCash = 125.500` y `totalAccountValue = 889.756` (cash disponible +
cash reservado + Σ `marketValue` de las posiciones con precio). `CANCELLED` y `REJECTED` no
afectan nada.

Query reutilizable con precio de mercado y P&L: `db/queries/portfolio.sql`.

---

## 4. Inconsistencias del seed (no son bugs tuyos)

1. **BMA queda en −10.** Se vendieron 30 (orden 11, `FILLED`) con sólo 20 compradas `FILLED`
   (orden 9); la compra de 60 quedó en `NEW` (orden 7). La API rechaza vender más de lo que se
   tiene, así que esa venta no se generaría desde cero: es una inconsistencia del dataset.
   Conclusión: **el seed no es un oráculo de negocio**, sólo un dataset de ejemplo.
2. **El seed rechaza la venta de PAMP** (orden 6: vender 100 con 50 en cartera → `REJECTED`),
   lo cual sí es coherente. Es decir: la regla se aplica, pero el seed tiene una excepción.
3. **Órdenes fechadas 12-jul pero market data arranca 13-jul.** El precio de ejecución viene
   en la orden, no de `marketdata`. No intentes resolver `MARKET` contra `marketdata.close`.
4. **`HIGH`/`LOW` de BMA el 13-jul (1541 / 1415) no contienen el precio de la orden 11 (1530)** —
   sí lo contiene en rango, ok; pero METR se ejecutó a 250 el 13-jul cuando el rango fue
   222,50–232,00. Los precios de las órdenes **no respetan la vela del día**. No valides contra marketdata.

---

## 5. Plan de consulta e índices

Con 11 filas en `orders` y 126 velas (el seed, §1), **el planner no es el problema**: todo entra
en un seq scan de milisegundos. Lo único que cuesta es el round-trip cuando la base está remota,
y por eso las suites y la iteración se corren contra PostgreSQL local (§6).

Índices reales del **head versionado** (los crean `20261103003419_init_trading_api` y
`20261106154910_db_integrity_constraints`; no existen en el snapshot legacy):

| Índice | Columnas | Qué consulta cubre |
| --- | --- | --- |
| `orders_userid_status_idx` | `orders (userid, status)` | Proyección de cash/posiciones y reservas: `WHERE userid = $1 AND status = …` (§3) — incluye `listRestingOrders` |
| `orders_status_instrumentid_idx` | `orders (status, instrumentid)` | Órdenes por estado e instrumento para el matching de límites; hoy `matchRestingOrders` no está cableado (ver `DECISIONS.md` D3) |
| `orders_userid_idempotencyKey_key` **UNIQUE** | `orders (userid, "idempotencyKey")` | Claim idempotente; múltiples `NULL` permitidos |
| `marketdata_instrumentid_date_idx` | `marketdata (instrumentid, date DESC)` | Último precio por instrumento |
| `marketdata_instrumentid_date_key` **UNIQUE** | `marketdata (instrumentid, date)` | Una vela por instrumento y fecha (§10) |
| `order_events_orderid_idx` | `order_events (orderid)` | Eventos de una orden |

**`orders(userid, datetime)` no está en el head y no corresponde:** ningún endpoint ordena
órdenes por `datetime`; el portfolio filtra por `userid` y `status` y agrega en memoria, y ese
filtro lo cubre `orders_userid_status_idx`. El índice `orders_userid_datetime_idx` sólo existe
como propuesta en `db/indexes.sql`, que **no se aplica** ni forma parte del head.

Deudas de esquema que quedan explícitas: `orders.status` sigue nullable y sin `DEFAULT 'NEW'`, y
`instruments.ticker` y `users.email` no tienen `UNIQUE` — el catálogo y los usuarios se leen por
`id`, y el alta de usuarios no es parte de esta API. Los CHECKs vigentes son los 10 de §10, no
los de `db/indexes.sql`.

---

## 6. Configuración y flujo de datos

La aplicación acepta cualquier PostgreSQL compatible mediante `DATABASE_URL`. Configurá la variable en `.env` para desarrollo o en el gestor de secretos del entorno; no guardes credenciales reales en Git. La configuración de `.env.example` es sólo un formato de referencia.

Para una base vacía preparada para esta versión, aplicar migraciones y cargar el dataset del challenge:

```bash
npx prisma migrate deploy
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/seed.sql
```

`db/seed.sql` modifica datos y debe ejecutarse sólo cuando se desea cargar el dataset del challenge. No se debe ejecutar sobre datos que se quieran conservar.

Las pruebas de integración usan `TEST_DATABASE_URL`, independiente de `DATABASE_URL`. PostgreSQL local es una opción para estas pruebas; cada suite funcional resetea su base de test antes de correr. No uses una base de aplicación/productiva para el reset de tests. El procedimiento vigente es:

```bash
npm run test:db:reset
npm test
```

Reglas:

- `db/schema.sql` y `db/seed.sql` **son generados**, no se editan a mano.
- El snapshot describe los datos de referencia; el DDL del head versionado son `prisma/migrations/**`.
- La conexión de la app y la de tests son responsabilidades distintas: `DATABASE_URL` para runtime, `TEST_DATABASE_URL` para suites con escritura.
- Los comandos de migración y seed afectan la DB indicada por `DATABASE_URL`; verificar el destino antes de ejecutarlos.

---

## 7. Decisiones de diseño aplicadas

Las decisiones de diseño que sostienen este esquema — con su contexto y sus consecuencias — viven en
`DECISIONS.md`. Resumen de cómo se aplican acá:

1. **Cash reservado:** las `LIMIT NEW` **reservan** (`limit × size` en BUY). Se
   muestra **separado**: `cash` = disponible (`settled − reservado`) y `reservedCash` — ver §3.
   `CASH_OUT` y los `BUY` validan contra el **disponible**.
2. **Concurrencia al debitar cash:** transacción con **`pg_advisory_xact_lock(userId)`**
   por usuario (validación + inserción en la misma tx): dos submits concurrentes que juntos
   exceden el cash dejan una `FILLED` y una `REJECTED` (testeado).
3. **Precio límite vs ejecución:** `price` = **límite enviado**, `filledPrice` = **precio
   de ejecución** (columna nueva de la migración); las filas legacy del seed leen con el
   `COALESCE` del mapper — ver §2.
4. **Precio de un `MARKET`:** el **`close` de la última vela por `date`** de
   `marketdata` (no hay motor de matching; no se valida contra el high/low del día — ver §4.4).
   Sin vela → `REJECTED NO_PRICE` persistida.
5. **Posiciones negativas:** no hay CHECK posible en el esquema; se resuelve en la
   transacción: `SELL` valida contra **posición FILLED − acciones reservadas**. La negativa
   heredada del seed (BMA −10) se **lista tal cual** (§4.1) y la validación impediría que entre
   de ahora en adelante.

---

## 8. Referencia rápida

```sql
-- ¿Qué usuarios tienen actividad?
SELECT userid, count(*) FROM orders GROUP BY 1 ORDER BY 2 DESC;

-- Último precio conocido por instrumento (sin datos → NULL)
SELECT DISTINCT ON (m.instrumentid) i.ticker, m.date, m.close
FROM marketdata m JOIN instruments i ON i.id = m.instrumentid
ORDER BY m.instrumentid, m.date DESC;

-- Órdenes abiertas (cancelables)
SELECT o.id, i.ticker, o.side, o.size, o.price, o.datetime
FROM orders o JOIN instruments i ON i.id = o.instrumentid
WHERE o.status = 'NEW' ORDER BY o.datetime;

-- Buscar instrumento por ticker o nombre
SELECT id, ticker, name, type FROM instruments
WHERE ticker ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
ORDER BY ticker LIMIT 20;
```

---

## 9. Grandes montos: tipos y CHECKs de la migración versionada

Objetivo aprobado (spec `specs/datos-financieros-grandes-montos.md` §2, D1/D2/D5) — migración
nueva versionada, create-only y **parte del head versionado**; el estado de aplicación sobre una base
concreta se verifica con `npx prisma migrate status` (§10):

| Campos | Snapshot legacy (`db/schema.sql`) | Head versionado (`prisma/schema.prisma` + migraciones) |
| --- | --- | --- |
| `orders.price`, `orders.filledPrice` | `numeric(10,2)` | `numeric(24,2)` — máximo por fila `9999999999999999999999.99`; NULL se conserva donde corresponde |
| `orders.size` | `integer` | `numeric(24,2)`, **entero almacenado** en BUY/SELL; pesos con centavos en cash |
| `marketdata.high`, `marketdata.low`, `marketdata.open`, `marketdata.close`, `marketdata.previousclose` | `numeric(10,2)` | `numeric(24,2)`, no negativos; se conserva el caso de precio 0 |
| IDs, FKs, secuencias | `integer` | **Sin cambios** — no UUID, no BIGINT de identificadores |

CHECKs acotados a los campos financieros modificados (excepción acotada D5 a "no editar
migraciones"; sólo la migración nueva, nunca la inicial ni los snapshots SQL):

- Todo precio no nulo debe ser finito; precio de orden positivo.
- `size` no nulo: finito y no negativo. En BUY/SELL, entero y ≤ 2147483647.
- `size 0`: la garantía SQL es de **una sola tabla** — el CHECK
  `orders_size_zero_only_rejected_check` exige que `status` sea `REJECTED`
  (`IS NOT DISTINCT FROM`, así un `status` NULL no se escapa). Ese CHECK **no** mira
  `order_events`: que el evento porte el motivo `ZERO_SIZE` es política de la
  aplicación y **no** se agrega ni se promete un CHECK cross-table sobre el motivo, ni
  DDL adicional. El alcance del `0` es distinto por lado: en cash queda reservado a los
  `REJECTED` históricos de `ZERO_SIZE` (compatibilidad §2); en trading una `REJECTED`
  también puede guardar `0` según el caso — `ZERO_SIZE` por sizing, y `NO_PRICE` cuando
  el sizing derivado de `amountArs` no llegó a resolverse por falta de precio. La DB
  garantiza el estado (`REJECTED`), no la razón; los históricos no se normalizan.
- Un NULL financiero ya permitido **no** se reemplaza por cero; la nullabilidad legacy no se
  endurece en este trabajo.
- No se agregan constraints de email/ticker, índices nuevos, triggers de estados ni cambios al
  mecanismo de idempotencia.

> **Alcance de esta lista:** es el de `20261105104903_large_money`. Las dos migraciones
> posteriores (§10) sí agregan un índice **UNIQUE** sobre `marketdata`, cuatro CHECKs de
> coherencia de escritura en `orders` y un trigger que **normaliza** `filledPrice` desde `price`
> (no es un trigger de estados ni toca la unicidad de idempotencia).

**Límite honesto:** `NUMERIC(24,2)` puede redondear una entrada SQL con escala mayor a 2
**antes** de que un CHECK la evalúe; el borde Zod la rechaza antes de persistir. Los CHECKs
garantizan el valor almacenado, no reconstruyen la precisión de escrituras SQL externas.

El seed del challenge **carga sin editarse** sobre el esquema final y conserva sus valores por
valor (cash disponible 627500.00, reservado 125500.00, patrimonio 889756.00; PAMP 40, METR 500,
BMA −10): lo que cambia es la forma JSON en que la API los representa, no el dinero persistido.
El procedimiento de despliegue (pausa de escrituras, backup, preflight, ensayo, rollback) y sus
condiciones están en la decisión D5 de `DECISIONS.md`.

---

## 10. Migraciones versionadas: inventario del head y verificación

`prisma/migrations/**` es el DDL real del head versionado: **cuatro** migraciones, en este orden.
`db/schema.sql` no las refleja (§1); la única forma de reproducir el schema es
`npx prisma migrate deploy`.

| Migración | Qué aporta |
| --- | --- |
| `20261103003419_init_trading_api` | Esquema base sobre el legacy: tabla `order_events` (auditoría append-only), seis enums nativos y en `orders` las columnas `"timeInForce"` (NOT NULL, default `GTC`), `filledPrice`, `filledAt`, `idempotencyKey` — con `UNIQUE(userid, "idempotencyKey")` |
| `20261105104903_large_money` | Los campos financieros pasan a la precisión del head y se agregan los CHECKs acotados de §9 (`orders_price_finite_positive_check`, `orders_filledprice_finite_positive_check`, `orders_size_finite_non_negative_check`, `orders_share_size_int4_check`, `orders_size_zero_only_rejected_check`, `marketdata_prices_finite_non_negative_check`) |
| `20261106154910_db_integrity_constraints` | `NOT NULL` en `marketdata.instrumentid/date/close/previousclose` y en `orders.type/side/datetime` (`orders.status` sigue nullable); columna `orders.requestFingerprint` (`text`, **nullable y sin UNIQUE**); índice único `marketdata_instrumentid_date_key`; CHECK `orders_filled_requires_execution_price_check` |
| `20261106180000_db_write_invariants` | Backfill `filledPrice = price` en las `FILLED` heredadas; función + trigger `orders_fill_execution_price_trigger`; CHECKs `orders_limit_requires_price_check`, `orders_cash_price_unit_check` y `orders_filled_requires_filledprice_check` |

**Total en el head: 10 CHECK constraints** — 9 en `orders` y 1 en `marketdata` — todas nacidas
`NOT VALID`-free (`convalidated = true`), y **1 trigger** (`orders_fill_execution_price_trigger`)
con su función `orders_fill_execution_price()`.

### Qué garantiza cada CHECK nuevo

| Constraint | Regla | Notas |
| --- | --- | --- |
| `orders_filled_requires_execution_price_check` | Una `FILLED` necesita **algún** precio: `filledPrice` o `price` | Es la invariante que el dataset legacy cumple; la forma estricta llega con el CHECK siguiente, después del backfill |
| `orders_limit_requires_price_check` | Una `LIMIT` necesita `price` | El repositorio no puede persistir una `LIMIT` sin límite |
| `orders_cash_price_unit_check` | `CASH_IN`/`CASH_OUT` sólo con precio unitario `1.00` | El monto del movimiento viaja en `size`, no en `price` |
| `orders_filled_requires_filledprice_check` | Una `FILLED` necesita `filledPrice` | Posible sólo **después** del backfill y con el trigger activo |

### Trigger de normalización (`orders_fill_execution_price_trigger`)

`BEFORE INSERT OR UPDATE OF "status", "price", "filledPrice"` sobre `orders`, `FOR EACH ROW`:
si `NEW.status = 'FILLED'` y `NEW."filledPrice" IS NULL` y `NEW."price" IS NOT NULL`, copia
`price` a `filledPrice`. Es la **misma** regla del backfill, aplicada a toda escritura — incluido
el `COPY` de `db/seed.sql`, que no trae `filledPrice` (por eso hace falta el trigger y no alcanza
con el backfill). Si una fila llega `FILLED` sin `price` **ni** `filledPrice`, el trigger no
inventa un valor: el INSERT falla ruidosamente con `23514` en
`orders_filled_requires_execution_price_check` (ese CHECK se evalúa antes que el de `filledPrice`).
No lee otras tablas ni otras filas.

### Cómo verificar el estado aplicado

```sql
-- 1) history de Prisma: 4 filas, finished_at no nulo, rolled_back_at nulo
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at
FROM "_prisma_migrations" ORDER BY started_at;

-- 2) 10 CHECKs presentes y validados (9 en orders + 1 en marketdata)
SELECT c.relname AS tabla, con.conname AS check, con.convalidated AS validado
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
WHERE con.contype = 'c' AND c.relname IN ('orders', 'marketdata')
ORDER BY 1, 2;

-- 3) trigger activo (tgenabled = 'O') y su función
SELECT t.tgname, t.tgenabled, p.proname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'orders'::regclass AND NOT t.tgisinternal;
```

Comandos equivalentes: `npx prisma migrate status` (debe decir *Database schema is up to date!*) y
`npx prisma migrate deploy` repetido (debe ser un no-op).

**Estado esperado tras `npx prisma migrate deploy`:** 4/4 migraciones `finished`, 0 `rolled_back`;
10 CHECKs con `convalidated = true`; trigger `enabled = 'O'`; `requestFingerprint` `text` nullable e
índice único `marketdata_instrumentid_date_key` presente. Los datos de `db/seed.sql` se conservan por
valor: 11 órdenes y 126 velas, las filas `FILLED` heredadas con `filledPrice` copiado desde `price`,
y los valores de §3 — cash settled `753000.00`, reservado `125500.00`, PAMP 40, METR 500, BMA −10.
