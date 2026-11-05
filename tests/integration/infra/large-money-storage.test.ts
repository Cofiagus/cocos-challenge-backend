// Integración (PostgreSQL real, DB aislada lm_b_*) — T4b de
// specs/datos-financieros-grandes-montos.md: la migración nueva
// 20261105104903_large_money amplía size y los siete precios a NUMERIC(24,2) y
// agrega los CHECKs financieros de D5.
//
// Prueba, contra pg raw y el CLI de Prisma (sin tipos de repos que otras
// células cambian): preflight del dataset legacy, conservación exacta de
// filas/IDs/keys/eventos al migrar viejo→nuevo, round-trip de máximo/centavo,
// rechazo de NaN/negativos/fracciones/fuera de INT4, rollback de una
// multi-escritura y DB nueva por `migrate deploy` + seed sin editar.
//
// Requiere TEST_DATABASE_URL (PostgreSQL 18); puede ser la URL global de test
// (p. ej. .../cocos_challenge_test). La suite SIEMPRE deriva sus propias bases
// lm_b_* desde esa URL y sólo crea/borra esas: nunca ejecuta DROP/CREATE sobre
// la base que la URL fuente nombra ni sobre APP_DATABASE_URL.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "pg";
import { databaseUrlForTestName } from "../../helpers/test-database-url.js";

jest.setTimeout(240_000);

const LEGACY_DATABASE = "lm_b_large_money_legacy";
const FRESH_DATABASE = "lm_b_large_money_fresh";
const INITIAL_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20261103003419_init_trading_api/migration.sql",
);
const LARGE_MONEY_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20261105104903_large_money/migration.sql",
);
const SEED_PATH = join(process.cwd(), "db/seed.sql");
const PRISMA_BIN = join(process.cwd(), "node_modules", ".bin", "prisma");

const databaseNameOf = (databaseUrl: string): string | null => {
  const name = new URL(databaseUrl).pathname.replace(/^\//u, "");
  return name.length > 0 ? decodeURIComponent(name) : null;
};

// Destino real de la app (APP_DATABASE_URL lo fija el harness/`.env`); ninguna
// base de ensayo puede llamarse igual ni recibir DROP/CREATE desde acá.
const applicationDatabaseName = (): string | null => {
  for (const variable of ["APP_DATABASE_URL", "DATABASE_URL"]) {
    const configured = process.env[variable];
    if (configured) {
      const name = databaseNameOf(configured);
      if (name) {
        return name;
      }
    }
  }
  return null;
};

const testDatabaseUrl = (): string => {
  const configured = process.env["TEST_DATABASE_URL"];
  if (!configured) {
    throw new Error("TEST_DATABASE_URL no definida; exportarla apuntando al PostgreSQL de test.");
  }
  const parsed = new URL(configured);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL debe usar el protocolo PostgreSQL.");
  }
  if (!databaseNameOf(configured)) {
    throw new Error("TEST_DATABASE_URL debe incluir el nombre de la base de test.");
  }
  return configured;
};

const validatedDatabaseName = (databaseName: string): string => {
  if (!/^lm_b_[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error(`Nombre de base fuera del prefijo lm_b_: ${databaseName}`);
  }
  if (databaseName === applicationDatabaseName()) {
    throw new Error(`La base de ensayo ${databaseName} coincide con la base de la app; abortado.`);
  }
  return databaseName;
};

const withDatabaseName = (databaseName: string): string =>
  new URL(databaseUrlForTestName(validatedDatabaseName(databaseName))).toString();

const adminDatabaseUrl = (): string => {
  const parsed = new URL(testDatabaseUrl());
  parsed.pathname = "/postgres";
  return parsed.toString();
};

const withClient = async <T>(
  databaseUrl: string,
  work: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const recreateDatabase = async (databaseName: string): Promise<void> => {
  const quotedName = `"${validatedDatabaseName(databaseName)}"`;
  await withClient(adminDatabaseUrl(), async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quotedName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quotedName} TEMPLATE template0`);
  });
};

const runPsqlFile = (databaseUrl: string, filePath: string): number => {
  const startedAtMs = Date.now();
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", filePath], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`psql falló sobre ${filePath}: ${result.stderr}`);
  }
  return Date.now() - startedAtMs;
};

type TextRow = Record<string, string | null>;

const ORDERS_SNAPSHOT_SQL = `
  SELECT id::text AS id, userid::text AS userid, instrumentid::text AS instrumentid,
         size::numeric(24,2)::text AS size,
         price::numeric(24,2)::text AS price,
         "filledPrice"::numeric(24,2)::text AS "filledPrice",
         type::text AS type, side::text AS side, status::text AS status,
         datetime::text AS datetime, "timeInForce"::text AS "timeInForce",
         "filledAt"::text AS "filledAt", "idempotencyKey" AS "idempotencyKey"
  FROM orders ORDER BY id`;

const MARKETDATA_SNAPSHOT_SQL = `
  SELECT id::text AS id, instrumentid::text AS instrumentid, date::text AS date,
         high::numeric(24,2)::text AS high, low::numeric(24,2)::text AS low,
         open::numeric(24,2)::text AS open, close::numeric(24,2)::text AS close,
         "previousclose"::numeric(24,2)::text AS "previousclose"
  FROM marketdata ORDER BY id`;

const EVENTS_SNAPSHOT_SQL = `
  SELECT id::text AS id, "orderid"::text AS "orderid", "eventType"::text AS "eventType",
         reason::text AS reason, metadata::text AS metadata
  FROM order_events ORDER BY id`;

const readRows = async (client: Client, sql: string): Promise<readonly TextRow[]> =>
  (await client.query<TextRow>(sql)).rows;

interface StorageSnapshot {
  readonly orders: readonly TextRow[];
  readonly marketdata: readonly TextRow[];
  readonly events: readonly TextRow[];
}

const takeSnapshot = async (client: Client): Promise<StorageSnapshot> => ({
  orders: await readRows(client, ORDERS_SNAPSHOT_SQL),
  marketdata: await readRows(client, MARKETDATA_SNAPSHOT_SQL),
  events: await readRows(client, EVENTS_SNAPSHOT_SQL),
});

const FINANCIAL_CONTROLS_SQL = `
  WITH movements AS (
    SELECT CASE side
             WHEN 'CASH_IN' THEN size::numeric
             WHEN 'CASH_OUT' THEN -(size::numeric)
             WHEN 'SELL' THEN price * size
             WHEN 'BUY' THEN -(price * size)
             ELSE 0::numeric
           END AS delta
    FROM orders WHERE status = 'FILLED'
  ), settled AS (SELECT coalesce(sum(delta), 0) AS cash FROM movements),
  reserved AS (
    SELECT coalesce(sum(price * size), 0) AS cash
    FROM orders WHERE status = 'NEW' AND side = 'BUY'
  )
  SELECT (settled.cash)::numeric(24,2)::text AS "cashSettled",
         (reserved.cash)::numeric(24,2)::text AS "cashReserved",
         (settled.cash - reserved.cash)::numeric(24,2)::text AS available
  FROM settled, reserved`;

type FinancialControls = {
  readonly cashSettled: string | null;
  readonly cashReserved: string | null;
  readonly available: string | null;
};

type PositionRow = {
  readonly ticker: string | null;
  readonly qty: string | null;
};

const POSITIONS_SQL = `
  SELECT i.ticker AS ticker,
         sum(CASE side WHEN 'BUY' THEN size WHEN 'SELL' THEN -(size) ELSE 0 END)::text AS qty
  FROM orders o JOIN instruments i ON i.id = o."instrumentid"
  WHERE o.status = 'FILLED' AND o.side IN ('BUY', 'SELL')
  GROUP BY i.ticker HAVING i.ticker IN ('PAMP', 'METR', 'BMA')
  ORDER BY i.ticker`;

const PREFLIGHT_SQL = `
  SELECT
    (SELECT count(*) FROM orders WHERE size < 0 OR price < 0 OR "filledPrice" < 0) AS "ordersNegative",
    (SELECT count(*) FROM orders WHERE size = 0) AS "ordersZeroSize",
    (SELECT count(*) FROM orders WHERE side IN ('CASH_IN','CASH_OUT') AND price <> 1.00) AS "cashPriceNotOne",
    (SELECT count(*) FROM orders WHERE side IN ('BUY','SELL')
       AND (size <> trunc(size) OR size > 2147483647)) AS "sharesOutOfInt4",
    (SELECT count(*) FROM marketdata
       WHERE least(high, low, open, close, "previousclose") < 0) AS "marketdataNegative"`;

type PreflightRow = Record<string, string | null>;

const expectConstraintViolation = async (
  client: Client,
  sql: string,
  constraintName: string,
): Promise<void> => {
  await client.query("BEGIN");
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK");
    const pgError = error as { constraint?: string };
    expect(pgError.constraint).toBe(constraintName);
    return;
  }
  await client.query("ROLLBACK");
  throw new Error(`se esperaba violación de ${constraintName}`);
};

const expectSqlRejected = async (client: Client, sql: string): Promise<string> => {
  await client.query("BEGIN");
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK");
    return (error as Error).message;
  }
  await client.query("ROLLBACK");
  throw new Error("se esperaba rechazo del motor");
};

const seedFinancialOrder = `INSERT INTO orders
  (userid, instrumentid, size, price, side, status, datetime)
  VALUES (1, 66, $1, $2, $3, $4, now()) RETURNING id::text AS id`;

describe("large money storage — migración NUMERIC(24,2) y CHECKs (DB real aislada)", () => {
  const legacyUrl = withDatabaseName(LEGACY_DATABASE);
  const freshUrl = withDatabaseName(FRESH_DATABASE);
  let controls: FinancialControls;
  let positions: readonly PositionRow[];
  let snapshotBefore: StorageSnapshot;
  let legacyMigrationMs = 0;

  beforeAll(async () => {
    await recreateDatabase(LEGACY_DATABASE);
    await recreateDatabase(FRESH_DATABASE);
    runPsqlFile(legacyUrl, INITIAL_MIGRATION_PATH);
    runPsqlFile(legacyUrl, SEED_PATH);
  });

  afterAll(async () => {
    for (const databaseName of [LEGACY_DATABASE, FRESH_DATABASE]) {
      const quotedName = validatedDatabaseName(databaseName);
      await withClient(adminDatabaseUrl(), async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${quotedName}" WITH (FORCE)`);
      });
    }
  });

  it("preflight legacy: seed sin violaciones y controles financieros intactos", async () => {
    await withClient(legacyUrl, async (client) => {
      const counts = await client.query<TextRow>(
        `SELECT (SELECT count(*) FROM users)::text AS users,
                (SELECT count(*) FROM instruments)::text AS instruments,
                (SELECT count(*) FROM orders)::text AS orders,
                (SELECT count(*) FROM marketdata)::text AS marketdata`,
      );
      expect(counts.rows[0]).toEqual({ users: "4", instruments: "66", orders: "11", marketdata: "126" });

      const preflight = (await client.query<PreflightRow>(PREFLIGHT_SQL)).rows[0];
      expect(preflight).toEqual({
        ordersNegative: "0",
        ordersZeroSize: "0",
        cashPriceNotOne: "0",
        sharesOutOfInt4: "0",
        marketdataNegative: "0",
      });

      controls = (await client.query<FinancialControls>(FINANCIAL_CONTROLS_SQL)).rows[0] as FinancialControls;
      positions = (await client.query<PositionRow>(POSITIONS_SQL)).rows;
    });
    expect(controls).toEqual({
      cashSettled: "753000.00",
      cashReserved: "125500.00",
      available: "627500.00",
    });
    expect(positions).toEqual([
      { ticker: "BMA", qty: "-10" },
      { ticker: "METR", qty: "500" },
      { ticker: "PAMP", qty: "40" },
    ]);
  });

  it("agrega filas legacy representativas (key, evento y REJECTED ZERO_SIZE) y snapshotea", async () => {
    await withClient(legacyUrl, async (client) => {
      const cash = await client.query<TextRow>(
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime, "idempotencyKey")
         VALUES (1, 66, 123, 1.00, 'CASH_IN', 'FILLED', now(), 'legacy-cash-key-123')
         RETURNING id::text AS id`,
      );
      const cashOrderId = cash.rows[0]?.["id"];
      expect(cashOrderId).toBe("12");
      await client.query(
        `INSERT INTO order_events ("orderid", "eventType", metadata)
         VALUES ($1, 'ACCEPTED', '{"amountArs":"123.45"}')`,
        [cashOrderId],
      );
      await client.query(
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
         VALUES (1, 47, 0, NULL, 'BUY', 'REJECTED', now())`,
      );
      await client.query(
        `INSERT INTO order_events ("orderid", "eventType", reason)
         VALUES (13, 'REJECTED', 'ZERO_SIZE')`,
      );
      snapshotBefore = await takeSnapshot(client);
    });
    expect(snapshotBefore.orders).toHaveLength(13);
    expect(snapshotBefore.events).toHaveLength(2);
  });

  it("aplica la migración nueva midiendo la ventana y conserva filas, IDs, keys y eventos", async () => {
    legacyMigrationMs = runPsqlFile(legacyUrl, LARGE_MONEY_MIGRATION_PATH);
    // Evidencia de la ventana observada en este entorno de ensayo (tabla chica,
    // rewrite de 8 columnas); no es un compromiso de duración para producción.
    console.log(`ventana ALTER NUMERIC(24,2) + CHECKs: ${legacyMigrationMs} ms`);
    expect(legacyMigrationMs).toBeGreaterThanOrEqual(0);

    await withClient(legacyUrl, async (client) => {
      expect(await takeSnapshot(client)).toEqual(snapshotBefore);
      const sequences = await client.query<TextRow>(
        `SELECT last_value::text AS value FROM orders_id_seq`,
      );
      expect(sequences.rows[0]?.["value"]).toBe("13");
    });
  });

  it("declara NUMERIC(24,2) en las ocho columnas y CHECKs inspeccionables en PostgreSQL", async () => {
    await withClient(legacyUrl, async (client) => {
      const columns = await client.query<TextRow>(
        `SELECT table_name || '.' || column_name AS column,
                data_type || '(' || numeric_precision || ',' || numeric_scale || ')' AS type
         FROM information_schema.columns
         WHERE (table_name = 'orders' AND column_name IN ('size','price','filledPrice'))
            OR (table_name = 'marketdata' AND column_name IN ('high','low','open','close','previousclose'))
         ORDER BY 1`,
      );
      expect(columns.rows.map((row) => `${row["column"]}=${row["type"]}`)).toEqual([
        "marketdata.close=numeric(24,2)",
        "marketdata.high=numeric(24,2)",
        "marketdata.low=numeric(24,2)",
        "marketdata.open=numeric(24,2)",
        "marketdata.previousclose=numeric(24,2)",
        "orders.filledPrice=numeric(24,2)",
        "orders.price=numeric(24,2)",
        "orders.size=numeric(24,2)",
      ]);

      const constraints = await client.query<TextRow>(
        `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid IN ('orders'::regclass, 'marketdata'::regclass) AND contype = 'c'
         ORDER BY conname`,
      );
      expect(constraints.rows.map((row) => row["name"])).toEqual([
        "marketdata_prices_finite_non_negative_check",
        "orders_filledprice_finite_positive_check",
        "orders_price_finite_positive_check",
        "orders_share_size_int4_check",
        "orders_size_finite_non_negative_check",
        "orders_size_zero_only_rejected_check",
      ]);
      for (const row of constraints.rows) {
        expect(row["definition"]).toContain("CHECK");
        expect(row["definition"]).toContain("NULL");
      }
    });
  });

  it("round-trip exacto de máximo, centavo y cero de marketdata", async () => {
    await withClient(legacyUrl, async (client) => {
      const max = "9999999999999999999999.99";
      const inserted = await client.query<TextRow>(
        seedFinancialOrder,
        [max, "1.00", "CASH_IN", "FILLED"],
      );
      const orderId = inserted.rows[0]?.["id"] as string;
      const readOrder = await client.query<TextRow>(
        `SELECT size::text AS size, price::text AS price FROM orders WHERE id = $1`,
        [orderId],
      );
      expect(readOrder.rows[0]).toEqual({ size: max, price: "1.00" });

      const cent = await client.query<TextRow>(seedFinancialOrder, ["0.01", "0.01", "CASH_OUT", "FILLED"]);
      const readCent = await client.query<TextRow>(
        `SELECT size::text AS size, price::text AS price FROM orders WHERE id = $1`,
        [cent.rows[0]?.["id"]],
      );
      expect(readCent.rows[0]).toEqual({ size: "0.01", price: "0.01" });

      await client.query(
        `INSERT INTO marketdata (instrumentid, high, low, open, close, "previousclose", date)
         VALUES (1, $1, 0, 0.01, $1, $1, '2026-11-05')`,
        [max],
      );
      const market = await client.query<TextRow>(
        `SELECT high::text AS high, low::text AS low, open::text AS open,
                close::text AS close, "previousclose"::text AS previousclose
         FROM marketdata WHERE date = '2026-11-05'`,
      );
      expect(market.rows[0]).toEqual({
        high: max,
        low: "0.00",
        open: "0.01",
        close: max,
        previousclose: max,
      });
    });
  });

  it("rechaza máximo+0.01 por overflow del typmod (límite D1)", async () => {
    await withClient(legacyUrl, async (client) => {
      const message = await expectSqlRejected(
        client,
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
         VALUES (1, 66, 10000000000000000000000.00, 1.00, 'CASH_IN', 'FILLED', now())`,
      );
      expect(message).toMatch(/overflow|fuera de rango/i);
    });
  });

  it.each([
    ["precio de orden en cero", "orders_price_finite_positive_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 1, 0, 'BUY', 'FILLED', now())`],
    ["precio de orden negativo", "orders_price_finite_positive_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 1, -1.00, 'BUY', 'FILLED', now())`],
    ["precio de orden NaN", "orders_price_finite_positive_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 1, 'NaN', 'BUY', 'FILLED', now())`],
    ["filledPrice NaN", "orders_filledprice_finite_positive_check",
      `INSERT INTO orders (userid, instrumentid, size, price, "filledPrice", side, status, datetime)
       VALUES (1, 47, 1, 10.00, 'NaN', 'BUY', 'FILLED', now())`],
    ["size negativo", "orders_size_finite_non_negative_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 66, -1, 1.00, 'CASH_IN', 'FILLED', now())`],
    ["size NaN", "orders_size_finite_non_negative_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 66, 'NaN', 1.00, 'CASH_IN', 'FILLED', now())`],
    ["size 0 en fila operable", "orders_size_zero_only_rejected_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 0, 10.00, 'BUY', 'NEW', now())`],
    ["size 0 con status NULL (CHECK no puede dar UNKNOWN)", "orders_size_zero_only_rejected_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 0, 10.00, 'BUY', NULL, now())`],
    ["acciones fraccionadas", "orders_share_size_int4_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 10.5, 10.00, 'BUY', 'FILLED', now())`],
    ["acciones fuera de INT4", "orders_share_size_int4_check",
      `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
       VALUES (1, 47, 2147483648, 10.00, 'SELL', 'FILLED', now())`],
    ["marketdata alto negativo", "marketdata_prices_finite_non_negative_check",
      `INSERT INTO marketdata (instrumentid, high, date) VALUES (1, -0.01, '2026-11-06')`],
    ["marketdata cierre NaN", "marketdata_prices_finite_non_negative_check",
      `INSERT INTO marketdata (instrumentid, close, date) VALUES (1, 'NaN', '2026-11-06')`],
  ])("rechaza %s", async (_label, constraintName, statement) => {
    await withClient(legacyUrl, async (client) => {
      await expectConstraintViolation(client, statement, constraintName);
    });
  });

  it("acepta cash grande (> INT4), cero REJECTED y NULLs financieros heredados", async () => {
    await withClient(legacyUrl, async (client) => {
      const cash = await client.query<TextRow>(
        seedFinancialOrder,
        ["2147483648.00", "1.00", "CASH_IN", "FILLED"],
      );
      expect(cash.rows[0]?.["id"]).toBeDefined();

      await client.query(
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
         VALUES (1, 47, 0, 10.00, 'BUY', 'REJECTED', now())`,
      );
      await client.query(
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
         VALUES (1, 47, 10, 10.00, 'BUY', NULL, now())`,
      );
      const positiveNullStatus = await client.query<TextRow>(
        `SELECT count(*)::text AS n FROM orders WHERE size = 10 AND price = 10.00 AND status IS NULL`,
      );
      expect(positiveNullStatus.rows[0]?.["n"]).toBe("1");

      await client.query(
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime)
         VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL)`,
      );
      await client.query(
        `INSERT INTO marketdata (instrumentid, high, low, open, close, "previousclose", date)
         VALUES (1, NULL, NULL, NULL, NULL, NULL, '2026-11-07')`,
      );
      const nulls = await client.query<TextRow>(
        `SELECT count(*)::text AS n FROM orders WHERE size IS NULL AND price IS NULL`,
      );
      expect(nulls.rows[0]?.["n"]).toBe("1");
    });
  });

  it("documenta el límite del typmod: escala > 2 se redondea ANTES del CHECK", async () => {
    await withClient(legacyUrl, async (client) => {
      await client.query(
        `INSERT INTO marketdata (instrumentid, high, date) VALUES (1, 1.005, '2026-11-08')`,
      );
      const stored = await client.query<TextRow>(
        `SELECT high::text AS high FROM marketdata WHERE date = '2026-11-08'`,
      );
      expect(stored.rows[0]?.["high"]).toBe("1.01");
    });
  });

  it("rollback de una multi-escritura no deja orden ni evento", async () => {
    await withClient(legacyUrl, async (client) => {
      const before = await client.query<TextRow>(
        `SELECT (SELECT count(*) FROM orders)::text AS orders,
                (SELECT count(*) FROM order_events)::text AS events`,
      );
      await client.query("BEGIN");
      const inserted = await client.query<TextRow>(
        `INSERT INTO orders (userid, instrumentid, size, price, side, status, datetime, "idempotencyKey")
         VALUES (1, 66, 10.01, 1.00, 'CASH_IN', 'FILLED', now(), 'rollback-key')
         RETURNING id::text AS id`,
      );
      await client.query(
        `INSERT INTO order_events ("orderid", "eventType", metadata)
         VALUES ($1, 'ACCEPTED', '{"amountArs":"10.01"}')`,
        [inserted.rows[0]?.["id"]],
      );
      await client.query("ROLLBACK");

      const after = await client.query<TextRow>(
        `SELECT (SELECT count(*) FROM orders)::text AS orders,
                (SELECT count(*) FROM order_events)::text AS events,
                (SELECT count(*) FROM orders WHERE "idempotencyKey" = 'rollback-key')::text AS keyed`,
      );
      expect(after.rows[0]).toEqual({
        orders: before.rows[0]?.["orders"],
        events: before.rows[0]?.["events"],
        keyed: "0",
      });
    });
  });

  it("DB nueva: migrate deploy aplica la migración nueva y el seed carga sin ediciones", async () => {
    const deploy = spawnSync(PRISMA_BIN, ["migrate", "deploy"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: freshUrl },
      timeout: 180_000,
    });
    expect(deploy.status).toBe(0);
    expect(deploy.stdout).toContain("large_money");

    runPsqlFile(freshUrl, SEED_PATH);
    await withClient(freshUrl, async (client) => {
      const counts = await client.query<TextRow>(
        `SELECT (SELECT count(*) FROM users)::text AS users,
                (SELECT count(*) FROM instruments)::text AS instruments,
                (SELECT count(*) FROM orders)::text AS orders,
                (SELECT count(*) FROM marketdata)::text AS marketdata`,
      );
      expect(counts.rows[0]).toEqual({ users: "4", instruments: "66", orders: "11", marketdata: "126" });

      const freshControls = (await client.query<FinancialControls>(FINANCIAL_CONTROLS_SQL)).rows[0];
      expect(freshControls).toEqual(controls);

      const columns = await client.query<TextRow>(
        `SELECT count(*)::text AS n FROM information_schema.columns
         WHERE ((table_name = 'orders' AND column_name IN ('size','price','filledPrice'))
             OR (table_name = 'marketdata' AND column_name IN ('high','low','open','close','previousclose')))
           AND data_type = 'numeric' AND numeric_precision = 24 AND numeric_scale = 2`,
      );
      expect(columns.rows[0]?.["n"]).toBe("8");
    });
  });
});
