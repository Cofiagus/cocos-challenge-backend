// Integración (PostgreSQL real, DBs aisladas di_b_*) — célula F3-DB:
// la migración 20261106154910_db_integrity_constraints lleva a la DB las
// invariantes que antes sólo garantizaba la app.
//
// Cubre: preflight medido del seed, conservación exacta al migrar una base
// legacy (filas/IDs/keys/cash/posiciones/patrimonio), las columnas NOT NULL,
// el UNIQUE(instrumentid, date) de marketdata, los CHECKs de coherencia
// estado/unidad, la columna requestFingerprint (nullable y SIN UNIQUE) y una
// DB nueva por `migrate deploy` + seed sin editar.
//
// Requiere TEST_DATABASE_URL (PostgreSQL 18). La suite deriva SIEMPRE sus
// propias bases di_b_* desde esa URL y sólo crea/borra esas: nunca ejecuta
// DROP/CREATE sobre la base que la URL fuente nombra ni sobre APP_DATABASE_URL.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "pg";
import { databaseUrlForTestName } from "../../helpers/test-database-url.js";

jest.setTimeout(240_000);

const LEGACY_DATABASE = "di_b_integrity_legacy";
const FRESH_DATABASE = "di_b_integrity_fresh";
const PREFIX = /^di_b_[a-z0-9_]+$/u;
const PRISMA_BIN = join(process.cwd(), "node_modules", ".bin", "prisma");
const INITIAL_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20261103003419_init_trading_api/migration.sql",
);
const LARGE_MONEY_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20261105104903_large_money/migration.sql",
);
const INTEGRITY_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20261106154910_db_integrity_constraints/migration.sql",
);
const SEED_PATH = join(process.cwd(), "db/seed.sql");

const databaseNameOf = (databaseUrl: string): string | null => {
  const name = new URL(databaseUrl).pathname.replace(/^\//u, "");
  return name.length > 0 ? decodeURIComponent(name) : null;
};

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
  if (!PREFIX.test(databaseName)) {
    throw new Error(`Nombre de base fuera del prefijo di_b_: ${databaseName}`);
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

const runPsqlFile = (databaseUrl: string, filePath: string): void => {
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", filePath], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`psql falló sobre ${filePath}: ${result.stderr}`);
  }
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

const readRows = async (client: Client, sql: string): Promise<readonly TextRow[]> =>
  (await client.query<TextRow>(sql)).rows;

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

const PORTFOLIO_VALUE_SQL = `
  WITH positions AS (
    SELECT i.ticker AS ticker,
           sum(CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -(o.size) ELSE 0 END) AS qty,
           (SELECT m.close FROM marketdata m WHERE m.instrumentid = i.id
             ORDER BY m.date DESC, m.id DESC LIMIT 1) AS close
    FROM orders o JOIN instruments i ON i.id = o.instrumentid
    WHERE o.status = 'FILLED' AND o.side IN ('BUY', 'SELL')
    GROUP BY i.id, i.ticker
    HAVING sum(CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -(o.size) ELSE 0 END) <> 0
  ), settled AS (
    SELECT coalesce(sum(CASE side WHEN 'CASH_IN' THEN size WHEN 'CASH_OUT' THEN -(size)
                                WHEN 'SELL' THEN price * size WHEN 'BUY' THEN -(price * size)
                                ELSE 0 END), 0) AS cash
    FROM orders WHERE status = 'FILLED'
  )
  SELECT ((SELECT cash FROM settled) + sum(qty * close))::numeric(24,2)::text AS "tav"
  FROM positions`;

const PREFLIGHT_SQL = `
  SELECT
    (SELECT count(*) FROM orders)::text AS "ordersTotal",
    (SELECT count(*) FROM orders
      WHERE instrumentid IS NULL OR userid IS NULL OR size IS NULL OR price IS NULL
         OR type IS NULL OR side IS NULL OR status IS NULL OR datetime IS NULL)::text AS "ordersAnyNull",
    (SELECT count(*) FROM orders WHERE status = 'FILLED' AND "filledPrice" IS NULL)::text
      AS "filledWithoutFilledPrice",
    (SELECT count(*) FROM orders WHERE status = 'FILLED' AND price IS NULL)::text
      AS "filledWithoutAnyPrice",
    (SELECT count(*) FROM orders WHERE type = 'LIMIT' AND price IS NULL)::text
      AS "limitWithoutPrice",
    (SELECT count(*) FROM orders WHERE side IN ('CASH_IN','CASH_OUT')
       AND (price IS DISTINCT FROM 1.00 OR instrumentid IS DISTINCT FROM 66))::text
      AS "cashBadUnit",
    (SELECT count(*) FROM marketdata WHERE close IS NULL)::text AS "marketCloseNull",
    (SELECT count(*) FROM marketdata WHERE "previousclose" IS NULL)::text AS "marketPreviousCloseNull",
    (SELECT count(*) FROM marketdata WHERE high IS NULL OR low IS NULL OR open IS NULL)::text
      AS "marketHighLowOpenNull",
    (SELECT count(*) FROM (SELECT instrumentid, date FROM marketdata
       GROUP BY 1, 2 HAVING count(*) > 1) duplicates)::text AS "marketDuplicates"`;

type Preflight = Record<string, string | null>;

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

const expectNotNullViolation = async (client: Client, sql: string, column: string): Promise<void> => {
  await client.query("BEGIN");
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK");
    const pgError = error as { code?: string; column?: string };
    expect(pgError.code).toBe("23502");
    expect(pgError.column).toBe(column);
    return;
  }
  await client.query("ROLLBACK");
  throw new Error(`se esperaba NOT NULL en ${column}`);
};

describe("db integrity constraints — migración de invariantes (DB real aislada)", () => {
  const legacyUrl = withDatabaseName(LEGACY_DATABASE);
  const freshUrl = withDatabaseName(FRESH_DATABASE);
  let ordersBefore: readonly TextRow[];
  let marketdataBefore: readonly TextRow[];
  let preflight: Preflight;

  beforeAll(async () => {
    await recreateDatabase(LEGACY_DATABASE);
    await recreateDatabase(FRESH_DATABASE);
    runPsqlFile(legacyUrl, INITIAL_MIGRATION_PATH);
    runPsqlFile(legacyUrl, LARGE_MONEY_MIGRATION_PATH);
    runPsqlFile(legacyUrl, SEED_PATH);
  });

  afterAll(async () => {
    for (const databaseName of [LEGACY_DATABASE, FRESH_DATABASE]) {
      const quotedName = validatedDatabaseName(databaseName);
      await withClient(adminDatabaseUrl(), async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quotedName} WITH (FORCE)`);
      });
    }
  });

  it("preflight legacy: los conteos que habilitan (o bloquean) cada constraint", async () => {
    await withClient(legacyUrl, async (client) => {
      preflight = (await client.query<Preflight>(PREFLIGHT_SQL)).rows[0] as Preflight;
      ordersBefore = await readRows(client, ORDERS_SNAPSHOT_SQL);
      marketdataBefore = await readRows(client, MARKETDATA_SNAPSHOT_SQL);
    });
    expect(preflight).toEqual({
      ordersTotal: "11",
      ordersAnyNull: "0",
      // 7 FILLED legacy guardan la ejecución en `price`: bloquean la forma
      // estricta `FILLED ⇒ filledPrice NOT NULL` (ver migración).
      filledWithoutFilledPrice: "7",
      filledWithoutAnyPrice: "0",
      limitWithoutPrice: "0",
      cashBadUnit: "0",
      marketCloseNull: "0",
      marketPreviousCloseNull: "0",
      marketHighLowOpenNull: "2",
      marketDuplicates: "0",
    });
    expect(ordersBefore).toHaveLength(11);
    expect(marketdataBefore).toHaveLength(126);
  });

  it("aplica la migración nueva y conserva filas, IDs, keys y valores por valor", async () => {
    runPsqlFile(legacyUrl, INTEGRITY_MIGRATION_PATH);
    await withClient(legacyUrl, async (client) => {
      expect(await readRows(client, ORDERS_SNAPSHOT_SQL)).toEqual(ordersBefore);
      expect(await readRows(client, MARKETDATA_SNAPSHOT_SQL)).toEqual(marketdataBefore);

      const controls = (await client.query<TextRow>(FINANCIAL_CONTROLS_SQL)).rows[0];
      expect(controls).toEqual({
        cashSettled: "753000.00",
        cashReserved: "125500.00",
        available: "627500.00",
      });
      const portfolio = (await client.query<TextRow>(PORTFOLIO_VALUE_SQL)).rows[0];
      expect(portfolio?.["tav"]).toBe("889756.00");

      const sequences = await client.query<TextRow>(
        `SELECT (SELECT last_value FROM orders_id_seq)::text AS orders,
                (SELECT last_value FROM marketdata_id_seq)::text AS marketdata`,
      );
      expect(sequences.rows[0]).toEqual({ orders: "11", marketdata: "126" });
    });
  });

  it("declara las columnas NOT NULL que el dominio exige y deja nullable las legacy", async () => {
    await withClient(legacyUrl, async (client) => {
      const columns = await client.query<TextRow>(
        `SELECT table_name || '.' || column_name AS column, is_nullable
         FROM information_schema.columns
         WHERE (table_name = 'orders'
                AND column_name IN ('type','side','datetime','status','size','price','instrumentid','userid','requestFingerprint'))
            OR (table_name = 'marketdata'
                AND column_name IN ('instrumentid','date','close','previousclose','high','low','open'))
         ORDER BY 1`,
      );
      expect(columns.rows.map((row) => `${row["column"]}=${row["is_nullable"]}`)).toEqual([
        "marketdata.close=NO",
        "marketdata.date=NO",
        "marketdata.high=YES",
        "marketdata.instrumentid=NO",
        "marketdata.low=YES",
        "marketdata.open=YES",
        "marketdata.previousclose=NO",
        "orders.datetime=NO",
        "orders.instrumentid=YES",
        "orders.price=YES",
        "orders.requestFingerprint=YES",
        "orders.side=NO",
        "orders.size=YES",
        "orders.status=YES",
        "orders.type=NO",
        "orders.userid=YES",
      ]);
    });
  });

  it("declara el UNIQUE de marketdata y los CHECKs de coherencia", async () => {
    await withClient(legacyUrl, async (client) => {
      const unique = await client.query<TextRow>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'marketdata' AND indexname = 'marketdata_instrumentid_date_key'`,
      );
      expect(unique.rows).toHaveLength(1);
      expect(unique.rows[0]?.["indexdef"]).toContain("UNIQUE");

      const checks = await client.query<TextRow>(
        `SELECT conname AS name, convalidated::text AS validated
         FROM pg_constraint
         WHERE conrelid = 'orders'::regclass AND contype = 'c' AND conname LIKE 'orders_%'
         ORDER BY conname`,
      );
      const names = checks.rows.map((row) => row["name"]);
      expect(names).toEqual([
        "orders_filled_requires_execution_price_check",
        "orders_filledprice_finite_positive_check",
        "orders_price_finite_positive_check",
        "orders_share_size_int4_check",
        "orders_size_finite_non_negative_check",
        "orders_size_zero_only_rejected_check",
      ]);
      expect(checks.rows.every((row) => row["validated"] === "true")).toBe(true);
      // Formas bloqueadas por el seed / los tests de caracterización vigentes:
      // la migración las documenta como BLOCKER y no las fuerza.
      expect(names).not.toContain("orders_filled_requires_filledprice_check");
      expect(names).not.toContain("orders_limit_requires_price_check");
      expect(names).not.toContain("orders_cash_price_unit_check");
    });
  });

  it("requestFingerprint: nullable, SIN UNIQUE y dos payloads iguales coexisten", async () => {
    await withClient(legacyUrl, async (client) => {
      const fee = `INSERT INTO orders
        (instrumentid, userid, size, price, type, side, status, datetime,
         "timeInForce", "idempotencyKey", "requestFingerprint")
        VALUES (47, 1, 10, 930.00, 'LIMIT', 'BUY', 'NEW', now(), 'GTC', $1, $2)
        RETURNING id::text AS id`;
      const first = await client.query<TextRow>(fee, ["fp-key-1", "fingerprint-abc"]);
      const second = await client.query<TextRow>(fee, ["fp-key-2", "fingerprint-abc"]);
      expect(first.rows[0]?.["id"]).toBeDefined();
      expect(second.rows[0]?.["id"]).toBeDefined();

      const legacy = await client.query<TextRow>(
        `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime)
         VALUES (47, 1, 10, 930.00, 'LIMIT', 'BUY', 'NEW', now())
         RETURNING "requestFingerprint"`,
      );
      expect(legacy.rows[0]?.["requestFingerprint"]).toBeNull();

      const uniqueIndexes = await client.query<TextRow>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'orders' AND indexdef LIKE '%requestFingerprint%'`,
      );
      expect(uniqueIndexes.rows).toHaveLength(0);
    });
  });

  it.each([
    ["FILLED sin ningún precio", "orders_filled_requires_execution_price_check",
      `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime)
       VALUES (47, 1, 10, NULL, 'MARKET', 'BUY', 'FILLED', now())`],
    ["vela duplicada (instrumentid, date)", "marketdata_instrumentid_date_key",
      `INSERT INTO marketdata (instrumentid, date, close, "previousclose")
       VALUES (47, '2023-07-14', 925.85, 921.80)`],
  ])("rechaza %s", async (_label, constraintName, statement) => {
    await withClient(legacyUrl, async (client) => {
      await expectConstraintViolation(client, statement, constraintName);
    });
  });

  it.each([
    ["orders.type", "type",
      `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime)
       VALUES (47, 1, 10, 930.00, NULL, 'BUY', 'NEW', now())`],
    ["marketdata.close", "close",
      `INSERT INTO marketdata (instrumentid, date, close, "previousclose")
       VALUES (47, '2026-11-06', NULL, 921.80)`],
    ["marketdata.date", "date",
      `INSERT INTO marketdata (instrumentid, date, close, "previousclose")
       VALUES (47, NULL, 925.85, 921.80)`],
  ])("rechaza NULL en %s", async (_label, column, statement) => {
    await withClient(legacyUrl, async (client) => {
      await expectNotNullViolation(client, statement, column);
    });
  });

  it("acepta FILLED legacy con filledPrice NULL (price es la ejecución) y velas con high/low/open NULL", async () => {
    await withClient(legacyUrl, async (client) => {
      const legacyFilled = await client.query<TextRow>(
        `SELECT count(*)::text AS n FROM orders
         WHERE status = 'FILLED' AND "filledPrice" IS NULL AND price IS NOT NULL`,
      );
      expect(legacyFilled.rows[0]?.["n"]).toBe("7");
      const nullableOhlc = await client.query<TextRow>(
        `SELECT count(*)::text AS n FROM marketdata
         WHERE high IS NULL AND low IS NULL AND open IS NULL`,
      );
      expect(nullableOhlc.rows[0]?.["n"]).toBe("2");
    });
  });

  it("DB nueva: migrate deploy aplica las tres migraciones y el seed carga sin ediciones", async () => {
    const deploy = spawnSync(PRISMA_BIN, ["migrate", "deploy"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: freshUrl },
      timeout: 180_000,
    });
    expect(deploy.status).toBe(0);
    expect(deploy.stdout).toContain("db_integrity_constraints");

    runPsqlFile(freshUrl, SEED_PATH);
    await withClient(freshUrl, async (client) => {
      const counts = await client.query<TextRow>(
        `SELECT (SELECT count(*) FROM users)::text AS users,
                (SELECT count(*) FROM instruments)::text AS instruments,
                (SELECT count(*) FROM orders)::text AS orders,
                (SELECT count(*) FROM marketdata)::text AS marketdata`,
      );
      expect(counts.rows[0]).toEqual({ users: "4", instruments: "66", orders: "11", marketdata: "126" });

      const controls = (await client.query<TextRow>(FINANCIAL_CONTROLS_SQL)).rows[0];
      expect(controls).toEqual({
        cashSettled: "753000.00",
        cashReserved: "125500.00",
        available: "627500.00",
      });
      const portfolio = (await client.query<TextRow>(PORTFOLIO_VALUE_SQL)).rows[0];
      expect(portfolio?.["tav"]).toBe("889756.00");

      const fingerprintColumn = await client.query<TextRow>(
        `SELECT count(*)::text AS n FROM information_schema.columns
         WHERE table_name = 'orders' AND column_name = 'requestFingerprint' AND data_type = 'text'`,
      );
      expect(fingerprintColumn.rows[0]?.["n"]).toBe("1");
    });
  });
});
