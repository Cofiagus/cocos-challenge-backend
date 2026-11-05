// Support de la suite funcional de ENVÍO (Célula E) — tests/functional/orders-submit.
//
// DB REAL y AISLADA: la URL de `cocos_challenge_submit` se deriva de
// TEST_DATABASE_URL y se recrea por suite con scripts/test-db-reset.sh.
//
// `DATABASE_URL` se fija al destino aislado de esta suite antes de usar Prisma;
// los repositorios y fixtures apuntan a la misma base de test.
//
// Dinero (AGENTS.md): los esperados se computan con el constructor financiero
// (FinancialDecimal, contracts) construido desde strings y se comparan como
// Decimal — nunca float.

import { databaseUrlForTestName } from "../../helpers/test-database-url.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express } from "express";
import { Pool, type QueryResultRow } from "pg";
import { FinancialDecimal } from "../../../src/contracts/index.js";
import { buildApp } from "../../../src/http/app.js";
import { buildOrdersRouter } from "../../../src/http/orders/orders-router.js";
import { buildPortfolioRouter } from "../../../src/http/portfolio/portfolio-router.js";
import { PrismaInstrumentRepository } from "../../../src/infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../../../src/infra/prisma/marketdata-repository.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { SEED_INSTRUMENT_ARS_ID } from "../../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

/** DB de ESTA suite (aislada por célula: el orquestador corre en paralelo). */
export const SUBMIT_DB_NAME = "cocos_challenge_submit";
export const SUBMIT_DB_URL = databaseUrlForTestName(SUBMIT_DB_NAME);

// ANTES del primer uso del singleton lazy (patrón read/support.ts).
process.env["DATABASE_URL"] = SUBMIT_DB_URL;

/** Resea cocos_challenge_submit: migrate deploy + db/seed.sql (idempotente). */
export const resetSubmitDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: SUBMIT_DB_NAME },
  });
};

/**
 * App LOCAL de esta suite (patrón DI de buildApp): el router de orders (Célula
 * E) con los repos Prisma reales contra cocos_challenge_submit + el router de
 * portfolio (Célula C) para leer el efecto de las reservas desde el test.
 * src/http/server.ts es del orquestador y no se toca.
 */
export const buildSubmitTestApp = (): Express => {
  const portfolioRead = new PrismaPortfolioReadRepository();
  const instruments = new PrismaInstrumentRepository();
  const marketdata = new PrismaMarketdataRepository();
  return buildApp([
    buildOrdersRouter({
      orders: new PrismaOrderRepository(),
      portfolioRead,
      instruments,
      marketdata,
    }),
    buildPortfolioRouter({ portfolioRead, marketdata, instruments }),
  ]);
};

// ---------------------------------------------------------------------------
// pg directo (asserts de filas) — misma URL, otro pool
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: SUBMIT_DB_URL, max: 1 });

/** Cierra el pool de asserts y el Prisma del singleton (worker limpio). */
export const closeSubmitDbPool = async (): Promise<void> => {
  await pool.end();
  await getPrismaClient().$disconnect();
};

const dbQuery = async <T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> => (await pool.query<T>(text, [...values])).rows;

/** Eventos de auditoría de una orden (eventType + reason de rechazo/cancel). */
export interface SubmitOrderEventRow {
  readonly eventType: string;
  readonly reason: string | null;
}

export const fetchSubmitOrderEvents = async (
  orderId: number,
): Promise<SubmitOrderEventRow[]> =>
  dbQuery<SubmitOrderEventRow>(
    'SELECT "eventType", reason FROM order_events WHERE orderid = $1 ORDER BY id ASC',
    [orderId],
  );

/** Fila de `orders` — columnas EXACTAS del schema migrado (ver Célula D db.ts). */
export interface SubmitOrderRow {
  readonly id: number;
  readonly userid: number | null;
  readonly side: string | null;
  readonly status: string | null;
  /** NUMERIC(24,2) (D1/D2): pg lo devuelve como string — acciones o pesos. */
  readonly size: string | null;
  readonly price: string | null;
  readonly "filledPrice": string | null;
  readonly "timeInForce": string;
  readonly "idempotencyKey": string | null;
}

export const fetchSubmitOrderRow = async (
  orderId: number,
): Promise<SubmitOrderRow | undefined> =>
  (
    await dbQuery<SubmitOrderRow>(
      `SELECT id, userid, side, status, size, price, "filledPrice", "timeInForce", "idempotencyKey"
         FROM orders WHERE id = $1`,
      [orderId],
    )
  )[0];

/**
 * Fila de orders con status FILLED: movió cash/acciones. `price` es el precio
 * de EJECUCIÓN en el dataset legacy; las FILLED creadas por la API (FASE 3)
 * guardan la ejecución en `filledPrice` (DECISIONS.md: price = límite, o NULL
 * en MARKET) ⇒ la proyección de cash es COALESCE(filledPrice, price).
 * Ver QUESTION del reporte: mapSettledMovementRow (célula B) aún mapea
 * `price` solo, y rompe/da mal el cash con filas creadas por la API.
 */
export const insertTestOrder = async (order: {
  readonly userId: number;
  readonly instrumentId: number;
  readonly side: string;
  /** Unidad física de `size` (D2): acciones (BUY/SELL) o pesos (CASH_*). */
  readonly size: string;
  readonly priceArs: string;
}): Promise<void> => {
  await dbQuery(
    `INSERT INTO orders
       (instrumentid, userid, side, type, status, size, price, datetime, "timeInForce")
     VALUES ($1, $2, $3, 'MARKET', 'FILLED', $4, $5, now(), 'GTC')`,
    [order.instrumentId, order.userId, order.side, order.size, order.priceArs],
  );
};

/**
 * Cash liquidado (cashSettled) proyectado por UNIDAD (D2): cash mueve su
 * `size` (pesos exactos); BUY/SELL mueve size × COALESCE(filledPrice, price)
 * — string ARS.
 */
export const sqlCashSettledArs = async (userId: number): Promise<string> => {
  const rows = await dbQuery<{ cash: string }>(
    `SELECT COALESCE(sum(CASE side
             WHEN 'CASH_IN'  THEN  size
             WHEN 'SELL'     THEN  size * COALESCE("filledPrice", price)
             WHEN 'CASH_OUT' THEN -size
             WHEN 'BUY'      THEN -size * COALESCE("filledPrice", price)
           END), 0) AS cash
       FROM orders
      WHERE userid = $1 AND status = 'FILLED'`,
    [userId],
  );
  // El SUM de NUMERIC(24,2) puede venir con escala 4 (size × price): la
  // aritmética SQL es exacta; la CUANTIZACIÓN a 2 decimales es de
  // presentación (AGENTS.md) y se hace acá, en Decimal, nunca float.
  const raw = rows[0]?.cash ?? "0";
  return new FinancialDecimal(raw)
    .toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP)
    .toFixed(2);
};

/** Cash SQL (string) esperado después de un delta: before ± delta (Decimal). */
export const sqlCashAfter = (
  cashBeforeArs: string,
  deltaArs: string,
): string =>
  new FinancialDecimal(cashBeforeArs)
    .plus(new FinancialDecimal(deltaArs))
    .toFixed(2);

/** Usuario fresco (sin órdenes) para aislar cada test — fixture de estado, sin repos. */
export const insertTestUser = async (email: string): Promise<number> => {
  const rows = await dbQuery<{ id: number }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("INSERT de users no devolvió id (fixture rota).");
  }
  return id;
};

/**
 * CASH_IN FILLED con la unidad vigente (D2/D4): el monto EXACTO viaja en
 * `size` (pesos, con centavos) y el precio unitario es 1.00 — sin sizing de
 * acciones ni floor. `requireCashUnitPrice` (mappers) exige ese 1.00 al leer.
 */
export const insertTestCashIn = async (
  userId: number,
  amountArs: string,
): Promise<void> => {
  await insertTestOrder({
    userId,
    instrumentId: SEED_INSTRUMENT_ARS_ID, // ARS: el instrumento del cash (docs §2)
    side: "CASH_IN",
    size: amountArs,
    priceArs: "1.00",
  });
};

/** Órdenes con una Idempotency-Key dada (UNIQUE(userid, idempotencyKey)). */
export const countSubmitOrdersWithIdempotencyKey = async (
  userId: number,
  idempotencyKey: string,
): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    'SELECT count(*)::int AS count FROM orders WHERE userid = $1 AND "idempotencyKey" = $2',
    [userId, idempotencyKey],
  );
  return rows[0]?.count ?? 0;
};

// ---------------------------------------------------------------------------
// Dinero: helpers de esperados (FinancialDecimal desde strings, nunca float)
// ---------------------------------------------------------------------------

/** size (acciones) × precio (string ARS) → string ARS exacto con 2 decimales. */
export const costArs = (size: number, priceArs: string): string =>
  new FinancialDecimal(String(size))
    .mul(new FinancialDecimal(priceArs))
    .toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP)
    .toFixed(2);

/** Cash esperado después de un delta: before ± delta (Decimal, nunca float). */
export const expectedCashAfter = (
  cashBefore: unknown,
  deltaArs: string,
): string => {
  if (typeof cashBefore !== "string") {
    throw new Error(
      `GET /portfolio no devolvió cash como string monetario (llegó ${String(cashBefore)}).`,
    );
  }
  return new FinancialDecimal(cashBefore)
    .plus(new FinancialDecimal(deltaArs))
    .toFixed(2);
};

/**
 * Assert de dinero serializado: el valor del contrato (MoneyArs, string con
 * EXACTAMENTE 2 decimales, D3) debe representar EXACTAMENTE el monto
 * esperado y con forma canónica; un number JSON NO es money válido. La
 * comparación es Decimal(actual) vs Decimal(expected), construidos desde
 * string — nunca float.
 */
const MONEY_OUTPUT_GRAMMAR = /^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$/;

export const expectMoneyArs = (actual: unknown, expectedArs: string): void => {
  if (
    typeof actual !== "string" ||
    !MONEY_OUTPUT_GRAMMAR.test(actual) ||
    actual === "-0.00"
  ) {
    throw new Error(
      `Se esperaba money serializado (string canónico de 2 decimales) igual a ${expectedArs}; llegó: ${String(actual)}`,
    );
  }
  expect(new FinancialDecimal(actual).toFixed(2)).toBe(expectedArs);
};