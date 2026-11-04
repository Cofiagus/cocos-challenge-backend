# Base de datos — esquema y guía de trabajo

PostgreSQL 18.6 (Neon, `us-east-2`) · base `neondb` · esquema `public` · ~7.8 MB

Este documento describe **qué hay en la base** y **cómo iterar contra ella sin perder tiempo**.
Si algo cambia en la base, se regenera el snapshot con `make db-snapshot` (ver §6).

---

## 1. Panorama

Cuatro tablas, sin vistas, sin funciones, sin triggers, sin enums, sin CHECK constraints.

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

### `orders`

| Columna        | Tipo                       | Nulo | Notas |
| -------------- | -------------------------- | ---- | ----- |
| `id`           | `integer`                  | NO   | |
| `instrumentid` | `integer`                  | sí   | → `instruments(id)` |
| `userid`       | `integer`                  | sí   | → `users(id)` |
| `size`         | `integer`                  | sí   | cantidad (entera, nunca fraccionaria) |
| `price`        | `numeric(10,2)`            | sí   | **precio de ejecución**, no solo el límite |
| `type`         | `varchar(10)`              | sí   | `MARKET` \| `LIMIT` |
| `side`         | `varchar(10)`              | sí   | `BUY` \| `SELL` \| `CASH_IN` \| `CASH_OUT` |
| `status`       | `varchar(20)`              | sí   | `NEW` \| `FILLED` \| `CANCELLED` \| `REJECTED` |
| `datetime`     | `timestamp` (sin tz)       | sí   | hora local del mercado |

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

**`price` se persiste al ejecutar.** Una orden `LIMIT` `NEW` guarda el precio límite; una `MARKET`
se guarda con el precio de ejecución que devolvió el mercado. No hay columna aparte para
"precio límite vs precio ejecutado": al llenar una `LIMIT` se sobrescribe `price`.
Si necesitás conservar ambos, es una **decisión de diseño pendiente** (ver §7).

`datetime` es `timestamp without time zone`: el seed está en hora local del mercado
(2023-07-12 y 2023-07-13, entre 12:11 y 16:11).

---

## 3. Cómo se derivan cash y posiciones

Regla que reproduce exactamente el seed verificado:

```sql
-- CASH de un usuario
SELECT sum(CASE side
             WHEN 'CASH_IN'  THEN  size * price
             WHEN 'SELL'     THEN  size * price
             WHEN 'CASH_OUT' THEN -size * price
             WHEN 'BUY'      THEN -size * price
           END) AS cash
FROM   orders
WHERE  userid = $1 AND status = 'FILLED';
```

```sql
-- POSICIONES de un usuario
SELECT o.instrumentid, i.ticker,
       sum(CASE o.side WHEN 'BUY' THEN o.size ELSE -o.size END) AS quantity,
       sum(CASE WHEN o.side='BUY' THEN o.size*o.price ELSE 0 END)
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
| Cash               | 753.000,00                   |
| Cash comprometido  | 125.500,00 (LOMA 35.500 + BMA 90.000, ambas `NEW`) |
| PAMP               | 40 @ 930,00 → 37.034 (mark 925,85) |
| METR               | 500 @ 250,00 → 114.750 (mark 229,50) |
| BMA                | **−10** @ 1.540,00 → −15.028 ⚠️ |

`db/queries/portfolio.sql` reproduce exactamente estos números — se validó cargando
`db/schema.sql` + `db/seed.sql` en un PostgreSQL 18 limpio y comparando contra el resultado
de Neon.

**Sólo `status = 'FILLED'` mueve plata.** `NEW` reserva (decisión tuya si se muestra como
"cash comprometido"), `CANCELLED` y `REJECTED` no afectan nada.

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
| `marketdata (instrumentid, date DESC)` **UNIQUE**    | "último precio" + evita velas duplicadas                        |
| `instruments (ticker)` **UNIQUE**                    | Búsqueda por ticker y dedupe                                     |
| `users (email)` **UNIQUE**                           | Login / alta                                                    |
| `CHECK (side IN (...))`, `CHECK (size > 0)`          | Los enums son `varchar(10)` sin validación                       |
| `orders.status NOT NULL DEFAULT 'NEW'`               | Hoy todo es nullable: un `INSERT` sin status rompe la proyección |

Están escritos y comentados en `db/indexes.sql` — **no** los apliques sobre Neon sin querer.

---

## 6. Flujo de trabajo recomendado

**Neon = fuente de verdad para el snapshot. Postgres local = donde iterás.**

```
Neon (remoto, ~200ms)  --make db-snapshot-->  db/schema.sql + db/seed.sql  --make db-load-->  localhost:5433 (~1ms)
```

```bash
make db-up         # levanta Postgres 16 local en docker (puerto 5433)
make db-load       # crea schema + carga seed
make db-reset      # drop + load, para volver al estado del seed
make psql          # abre psql contra la base local
make prices        # corre db/queries/portfolio.sql para el user 1

# re-baja schema+datos desde Neon (necesita NEON_DATABASE_URL, ver .env.example)
export NEON_DATABASE_URL="postgresql://neondb_owner:...@ep-billowing-dawn-b4kamvr4.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require"
make db-snapshot
```

> El snapshot se generó y se **validó cargándolo en un PostgreSQL 18 limpio**: 4/66/11/126
> filas, `schema.sql` y `seed.sql` cargan sin errores, `db/indexes.sql` aplica sin conflictos
> y `db/queries/portfolio.sql` devuelve exactamente los valores de §3.

`.env` local: `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/cocos_challenge`

Reglas:

- `db/schema.sql` y `db/seed.sql` **son generados**, no se editan a mano.
- Si el challenge pide "usar la base tal cual", la verdad es el snapshot; Neon se usa para
  la demo final y para verificar que las migraciones corren contra la base real.
- Para tests de integración: levantar el Postgres local y cargar `db/schema.sql` en un
  template (`CREATE DATABASE test TEMPLATE cocos`) — tarda milisegundos.

---

## 7. Decisiones de diseño pendientes

1. **Cash reservado**: ¿las órdenes `LIMIT NEW` descuentan del cash disponible? El seed no lo
   resuelve. Si sí, la proyección necesita un `status IN ('NEW','FILLED')` para reservas y
   `FILLED` para el saldo real. Recomendado: mostrarlo separado (`cash` + `cashReserved`).
2. **Concurrencia al debitar cash**: derivar de `orders` hace que el débito sea un `INSERT`
   bajo `SERIALIZABLE`, o `SELECT ... FOR UPDATE` sobre `users`. Sin lock vas a permitir
   sobre-giro con dos requests concurrentes. Es el punto más delicado del challenge.
3. **Precio límite vs ejecución**: hoy una sola columna `price`. Al llenar una `LIMIT` se pierde
   el límite original. Agregar `limitprice` o un `executions` aparte.
4. **Precio de un `MARKET`**: no hay motor de matching. Opciones: precio de la orden entrante,
   `marketdata.close` del último día, o un mock. El seed sugiere que **el precio viene de afuera**.
5. **Posiciones negativas**: falta la regla dura "no vender lo que no tenés" a nivel esquema
   (no hay CHECK posible; se resuelve en la transacción).

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
