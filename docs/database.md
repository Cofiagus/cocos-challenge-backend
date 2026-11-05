# Base de datos — esquema y guía de trabajo

PostgreSQL compatible con el esquema migrado · esquema `public` · dataset de referencia del challenge

Este documento describe **qué hay en la base** y **cómo iterar contra ella sin perder tiempo**.
Si algo cambia en la base, se regenera el snapshot con `make db-snapshot` (ver §6).

> ⚠️ **Snapshot legacy vs esquema vigente.** Este documento describe el **snapshot generado**
> (`db/schema.sql` + `db/seed.sql`), que es la fuente de los DATOS del challenge. El **esquema con
> el que corre la app** es el **MIGRADO** (`prisma/migrations/**`): agrega a `orders` las columnas
> `"timeInForce"`, `filledPrice`, `filledAt`, `idempotencyKey` y crea la tabla `order_events`
> (auditoría). El seed carga **sin ediciones** sobre el esquema migrado (las filas viejas quedan
> en `GTC`/`filledPrice NULL`). Para levantar una base de la app: `npx prisma migrate deploy` +
> `psql -f db/seed.sql` — **no** `make db-load LEGACY=1` (ese aplica el snapshot legacy). Ver §2 y §6.

> ⚠️ **Grandes montos (spec aprobada, D1–D5).** La migración **versionada nueva** (aún no aplicada;
> el estado lo registra `PROGRESS.md`) amplia los campos financieros a `NUMERIC(24,2)`: `orders.price`,
> `orders.filledPrice`, `orders.size` y los 5 precios de `marketdata`. Los IDs, FKs y secuencias
> **quedan INTEGER** (sin UUID ni BIGINT de identificadores). La guía operativa de la ventana
> coordinada vive en [`README.md` → Migración coordinada](../README.md#migración-coordinada-de-grandes-montos);
> los tipos y CHECKs objetivo están en §9.

---

## 1. Panorama

El **snapshot legacy** (`db/schema.sql`) tiene cuatro tablas, sin vistas, sin funciones, sin
triggers, sin enums y sin CHECK constraints. El **esquema migrado** (`prisma/migrations/**`)
agrega `order_events` (cinco tablas) y seis enums nativos: `OrderType`, `OrderSide`,
`OrderStatus`, `TimeInForce`, `OrderEventType` y `OrderEventReason`.

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

| Columna         | Tipo          | Nulo |
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
Sin `UNIQUE (instrumentid, date)` → nada impide duplicar una vela.

Los cinco precios quedan `numeric(10,2)` en el snapshot y en el esquema migrado vigente; la migración de grandes montos los amplia a `numeric(24,2)` conservando nombres, mapeos y nullabilidad.

### `orders`

Tipos del **snapshot legacy**; en el esquema migrado `type`/`side`/`status` son enums nativos
(`OrderType`, `OrderSide`, `OrderStatus`) y `idempotencyKey` es `text`.

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
| `datetime`     | `timestamp` (sin tz)       | sí   | hora local del mercado |

**Columnas del esquema MIGRADO** (no están en el snapshot legacy — `prisma/migrations/**`):

| Columna         | Tipo        | Nulo | Default | Notas |
| --------------- | ----------- | ---- | ------- | ----- |
| `"timeInForce"` | `TimeInForce` (enum) | NO | `'GTC'` | toda orden conoce su TIF; las filas del seed quedan en `GTC`; se ignora para `MARKET` |
| `filledPrice`   | `numeric(10,2)` | sí | — | **precio de ejecución** si `FILLED`; `NULL` si no ejecutó |
| `filledAt`      | `timestamp(6)` | sí | — | cuándo ejecutó |
| `idempotencyKey` | `text` | sí | — | claim idempotente; `UNIQUE(userid, idempotencyKey)` (múltiples `NULL` permitidos) |

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
> una sola columna `price` con el precio de ejecución. Esas filas llevan la ejecución en `price`
> y `filledPrice NULL`; el mapper de lectura aplica `filledPrice ?? price`, así el snapshot carga
> tal cual sobre el esquema migrado y la app ve la ejecución correcta en las filas viejas.

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

`datetime` es `timestamp without time zone`: el seed está en hora local del mercado
(2023-07-12 y 2023-07-13, entre 12:11 y 16:11).

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
ejecución en `filledPrice` (y en `price` el límite, o `NULL` en `MARKET`); sólo las filas
legacy del seed lo tienen en `price`. Los números de esta sección no cambian: el seed tiene
`filledPrice NULL` en todas sus filas.

Tras la migración de grandes montos estas queries no cambian: operan sobre `numeric(24,2)` y
devuelven `numeric` exacto (la API serializa el dinero como string de 2 decimales; el SQL nunca
convierte plata a float).

`db/queries/portfolio.sql` reproduce exactamente estos números — se validó cargando
`db/schema.sql` + `db/seed.sql` en un PostgreSQL 18 limpio y comparando contra el resultado
de Neon.

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
   (orden 9); la compra de 60 quedó en `NEW` (orden 7). Si implementás la validación estricta
   de "no vender más de lo que tenés", esa orden debería haber sido `REJECTED`.
   Conclusión: **el seed no es un oráculo de negocio**, sólo un dataset de ejemplo.
2. **El seed rechaza la venta de PAMP** (orden 6: vender 100 con 50 en cartera → `REJECTED`),
   lo cual sí es coherente. Es decir: la regla se aplica, pero el seed tiene una excepción.
3. **Órdenes fechadas 12-jul pero market data arranca 13-jul.** El precio de ejecución viene
   en la orden, no de `marketdata`. No intentes resolver `MARKET` contra `marketdata.close`.
4. **`HIGH`/`LOW` de BMA el 13-jul (1541 / 1415) no contienen el precio de la orden 11 (1530)** —
   sí lo contiene en rango, ok; pero METR se ejecutó a 250 el 13-jul cuando el rango fue
   222,50–232,00. Los precios de las órdenes **no respetan la vela del día**. No valides contra marketdata.

---

## 5. Estado de performance

Con 7.8 MB de base y 11 filas en `orders`, **el planner no es el problema**: todo entra en un
seq scan de milisegundos. Lo que cuesta es la red.

| Métrica (medida desde Buenos Aires)  | Valor        |
| ------------------------------------ | ------------ |
| Connect (IPv4 forzado)               | ~1,1 s       |
| Connect sin forzar IPv4              | **~91 s** ⚠️ |
| Round-trip por query                 | **~200 ms**  |

### ⚠️ Trampa nº1: IPv6 sin ruta

El host de Neon devuelve registros **AAAA además de A**. Si la máquina tiene IPv6 "anunciado"
pero sin ruta real, `connect()` queda en `SYN-SENT` contra la IPv6 hasta el timeout: **90 s
por intento**, y encima parece un cold start de Neon (no lo es).

Síntoma:

```bash
ss -tanp | grep 5432
# SYN-SENT ... [2800:...]:xxxxx [2600:1f16:...]:5432   <- atascado en IPv6
```

Solución: resolver el A record y pasarlo como `hostaddr` (manteniendo `host` para el TLS/SNI).
Es lo que hace `scripts/db-snapshot.py::connect()`, y sirve para cualquier cliente:

```python
ip = socket.getaddrinfo(host, 5432, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
psycopg.connect(dsn, hostaddr=ip)
```

Con Node/Prisma: `?host=<ip>&sslmode=require` o `dns.setDefaultResultOrder('ipv4first')`.

### Consecuencias prácticas

- **No iteres contra Neon.** Un endpoint con 5 queries = ~1 s de latencia pura.
- La URL del challenge apunta al **pooler** (`...-pooler...`): PgBouncer en modo transacción.
  Rompe `LISTEN/NOTIFY`, advisory locks de sesión, prepared statements con nombre y
  `SET LOCAL` fuera de transacción. Para migraciones (Prisma, Knex, TypeORM) usá el host
  **sin** `-pooler`; para el runtime, el `-pooler` está bien.

Faltantes que sí importan cuando el volumen crezca (no ahora):

| Índice / constraint                                  | Por qué                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `orders (userid, datetime DESC)`                     | Es *la* query del portfolio y del historial                     |
| `orders (status)` parcial `WHERE status='NEW'`       | Cancelar y matchear límites                                     |
| `marketdata (instrumentid, date DESC)` **UNIQUE**    | El índice ya existe en la migración; falta el UNIQUE, que evita velas duplicadas |
| `instruments (ticker)` **UNIQUE**                    | Búsqueda por ticker y dedupe                                     |
| `users (email)` **UNIQUE**                           | Login / alta                                                    |
| `CHECK (size > 0)`                                   | `size` no tiene validación general en la DB; la migración de grandes montos agrega CHECKs **acotados a los campos financieros modificados** (ver §9) — no esta regla amplia |
| `orders.status NOT NULL DEFAULT 'NEW'`               | Hoy todo es nullable: un `INSERT` sin status rompe la proyección |

Están escritos y comentados en `db/indexes.sql` — **no** los apliques sobre Neon sin querer.

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
- El snapshot describe los datos de referencia; el DDL vigente son `prisma/migrations/**`.
- La conexión de la app y la de tests son responsabilidades distintas: `DATABASE_URL` para runtime, `TEST_DATABASE_URL` para suites con escritura.
- Los comandos de migración y seed afectan la DB indicada por `DATABASE_URL`; verificar el destino antes de ejecutarlos.

---

## 7. Decisiones de diseño (resueltas en el build)

Las que este documento dejó "pendientes" al inicio quedaron resueltas — el detalle con el
porqué vive en `README.md` → *Supuestos y decisiones*:

1. **Cash reservado — RESUELTO:** las `LIMIT NEW` **reservan** (`limit × size` en BUY). Se
   muestra **separado**: `cash` = disponible (`settled − reservado`) y `reservedCash` — ver §3.
   `CASH_OUT` y los `BUY` validan contra el **disponible**.
2. **Concurrencia al debitar cash — RESUELTO:** transacción con **`pg_advisory_xact_lock(userId)`**
   por usuario (validación + inserción en la misma tx): dos submits concurrentes que juntos
   exceden el cash dejan una `FILLED` y una `REJECTED` (testeado).
3. **Precio límite vs ejecución — RESUELTO:** `price` = **límite enviado**, `filledPrice` = **precio
   de ejecución** (columna nueva de la migración); las filas legacy del seed leen con el
   `COALESCE` del mapper — ver §2.
4. **Precio de un `MARKET` — RESUELTO:** el **`close` de la última vela por `date`** de
   `marketdata` (no hay motor de matching; no se valida contra el high/low del día — ver §4.4).
   Sin vela → `REJECTED NO_PRICE` persistida.
5. **Posiciones negativas — RESUELTO:** no hay CHECK posible en el esquema; se resuelve en la
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
nueva versionada, create-only, **aún no aplicada**:

| Campos | Hoy (migrado vigente) | Con la migración |
| --- | --- | --- |
| `orders.price`, `orders.filledPrice` | `numeric(10,2)` | `numeric(24,2)` — máximo por fila `9999999999999999999999.99`; NULL se conserva donde corresponde |
| `orders.size` | `integer` | `numeric(24,2)`, **entero almacenado** en BUY/SELL; pesos con centavos en cash |
| `marketdata.high`, `low`, `open`, `close`, `previousClose` | `numeric(10,2)` | `numeric(24,2)`, no negativos; se conserva el caso de precio 0 |
| IDs, FKs, secuencias | `integer` | **Sin cambios** — no UUID, no BIGINT de identificadores |

CHECKs acotados a los campos financieros modificados (excepción firmada D5 a "no editar
migraciones"; sólo la migración nueva, nunca la inicial ni los snapshots SQL):

- Todo precio no nulo debe ser finito; precio de orden positivo.
- `size` no nulo: finito y no negativo. En BUY/SELL, entero y ≤ 2147483647; `size 0` sólo
  compatible con `REJECTED`. En cash, `0` sólo para los `REJECTED` históricos de `ZERO_SIZE`.
- Un NULL financiero ya permitido **no** se reemplaza por cero; la nullabilidad legacy no se
  endurece en este trabajo.
- No se agregan constraints de email/ticker, índices nuevos, triggers de estados ni cambios al
  mecanismo de idempotencia.

**Límite honesto:** `NUMERIC(24,2)` puede redondear una entrada SQL con escala mayor a 2
**antes** de que un CHECK la evalúe; el borde Zod la rechaza antes de persistir. Los CHECKs
garantizan el valor almacenado, no reconstruyen la precisión de escrituras SQL externas.

El seed del challenge **carga sin editarse** sobre el esquema final y conserva sus valores por
valor (cash disponible 627500.00, reservado 125500.00, patrimonio 889756.00; PAMP 40, METR 500,
BMA −10): lo que cambia es la forma JSON en que la API los representa, no el dinero persistido.
El procedimiento de despliegue (pausa de escrituras, backup, preflight, ensayo, rollback) está en
[`README.md` → Migración coordinada](../README.md#migración-coordinada-de-grandes-montos).
