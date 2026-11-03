// Support de la suite funcional de TRANSFERENCIAS (Célula G) —
// tests/functional/transfers.
//
// DB REAL y AISLADA: `cocos_challenge_transfer` en el cluster local
// (localhost:5433, auth trust), creada con
// `TEST_DB_NAME=cocos_challenge_transfer npm run test:db:reset` y con
// self-reset en beforeAll (patrón EXACTO de
// tests/functional/orders-submit/support.ts — Célula E, sólo lectura).
//
// DATABASE_URL se fija ACÁ, a la DB de ESTA suite, antes del primer uso del
// singleton lazy de src/lib/prisma-client.ts: la app bajo test (los repos
// Prisma reales de la célula B) NUNCA apunta a la DB de otra célula, aunque
// el proceso traiga otra variable (p. ej. .env.test → cocos_challenge_test).
//
// CONVENCIÓN DEL SEED para las fixtures de cash (docs/database.md §2):
// las filas CASH son orders del instrumento ARS (id 66, type MONEDA) con
// price = 1.00 y size = pesos — deriveCash proyecta size × price = pesos.
// La fixture de CASH_IN usa la MISMA convención que el seed (filledPrice
// NULL; el mapper de B hace COALESCE(filledPrice, price) — GATE 3).
//
// Dinero (AGENTS.md): los esperados se computan con Decimal construido
// desde strings y se comparan como Decimal — nunca float.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Decimal } from "decimal.js";
import type { Express } from "express";
import { Pool, type QueryResultRow } from "pg";
import { buildApp } from "../../../src/http/app.js";
import { buildPortfolioRouter } from "../../../src/http/portfolio/portfolio-router.js";
import { buildTransfersRouter } from "../../../src/http/transfers/transfers-router.js";
import { PrismaInstrumentRepository } from "../../../src/infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../../../src/infra/prisma/marketdata-repository.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { sizeSharesFromAmountArs } from "../../../src/domain/index.js";
import { SEED_INSTRUMENT_ARS_ID } from "../../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

/** DB de ESTA suite (aislada por célula: el orquestador corre en paralelo). */
export const TRANSFERS_DB_NAME = "cocos_challenge_transfer";
export const TRANSFERS_DB_URL = `postgresql://postgres@localhost:5433/${TRANSFERS_DB_NAME}`;

// ANTES del primer uso del singleton lazy (patrón orders-submit/support.ts).
// Se RESTAURA en closeTransfersDbPool: el worker de jest se reusa para otros
// archivos de tests (p. ej. tests/db.smoke.test.ts lee DATABASE_URL vía
// .env.test y dotenv NO pisa una variable ya presente).
const PREVIOUS_DATABASE_URL: string | undefined = process.env["DATABASE_URL"];
process.env["DATABASE_URL"] = TRANSFERS_DB_URL;

/** Resea cocos_challenge_transfer: migrate deploy + db/seed.sql (idempotente). */
export const resetTransfersDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: TRANSFERS_DB_NAME },
  });
};

/**
 * App LOCAL de esta suite (patrón DI de buildApp): el router de transfers
 * (Célula G) con los repos Prisma reales contra cocos_challenge_transfer +
 * el router de portfolio (Célula C) para leer el efecto en el disponible
 * desde el test. src/http/server.ts es del orquestador y no se toca.
 */
export const buildTransfersTestApp = (): Express => {
  const portfolioRead = new PrismaPortfolioReadRepository();
  const instruments = new PrismaInstrumentRepository();
  const marketdata = new PrismaMarketdataRepository();
  return buildApp([
    buildTransfersRouter({
      orders: new PrismaOrderRepository(),
      portfolioRead,
      instruments,
    }),
    buildPortfolioRouter({ portfolioRead, marketdata, instruments }),
  ]);
};

// ---------------------------------------------------------------------------
// pg directo (fixtures + asserts de filas) — misma URL, otro pool
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: TRANSFERS_DB_URL, max: 1 });

/** Cierra el pool de asserts, el Prisma del singleton y RESTORA el env. */
export const closeTransfersDbPool = async (): Promise<void> => {
  await pool.end();
  await getPrismaClient().$disconnect();
  if (PREVIOUS_DATABASE_URL === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = PREVIOUS_DATABASE_URL;
  }
};

const dbQuery = async <T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> => (await pool.query<T>(text, [...values])).rows;

/** Usuario fresco (sin órdenes) para aislar cada test — fixture de estado. */
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
 * CASH_IN FILLED con la convención del SEED (docs §2): instrumento ARS
 * (id 66), size = pesos (enteros), price = 1.00, filledPrice NULL (fila
 * legacy del dataset — el mapper de B hace COALESCE(filledPrice, price)).
 * ⇒ cash settled += amountArs. El size se deriva con la MISMA regla de
 * sizing del dominio (floor(amountArs / 1.00) — Decimal, nunca float).
 */
export const insertTestCashIn = async (
  userId: number,
  amountArs: string,
): Promise<void> => {
  const sizeShares = sizeSharesFromAmountArs(
    new Decimal(amountArs),
    new Decimal("1.00"),
  );
  await dbQuery(
    `INSERT INTO orders
       (instrumentid, userid, side, type, status, size, price, datetime, "timeInForce")
     VALUES ($1, $2, 'CASH_IN', 'MARKET', 'FILLED', $3, 1.00, now(), 'GTC')`,
    [SEED_INSTRUMENT_ARS_ID, userId, sizeShares],
  );
};

/**
 * BUY LIMIT GTC NEW (resting): reserva limit × size de cash
 * (deriveReservations sobre órdenes NEW — DECISIONS.md). Fixture para
 * reproducir el estado golden del seed (reservas) en un usuario fresco.
 */
export const insertTestRestingBuy = async (
  userId: number,
  instrumentId: number,
  sizeShares: number,
  limitPriceArs: string,
): Promise<void> => {
  await dbQuery(
    `INSERT INTO orders
       (instrumentid, userid, side, type, status, size, price, datetime, "timeInForce")
     VALUES ($1, $2, 'BUY', 'LIMIT', 'NEW', $3, $4, now(), 'GTC')`,
    [instrumentId, userId, sizeShares, limitPriceArs],
  );
};

/** Eventos de auditoría de una orden (eventType + reason + metadata). */
export interface TransfersOrderEventRow {
  readonly eventType: string;
  readonly reason: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export const fetchTransfersOrderEvents = async (
  orderId: number,
): Promise<TransfersOrderEventRow[]> =>
  dbQuery<TransfersOrderEventRow>(
    'SELECT "eventType", reason, metadata FROM order_events WHERE orderid = $1 ORDER BY id ASC',
    [orderId],
  );

/** Fila de `orders` — columnas EXACTAS del schema migrado (ver Célula D db.ts). */
export interface TransfersOrderRow {
  readonly id: number;
  readonly userid: number | null;
  readonly side: string | null;
  readonly status: string | null;
  readonly size: number | null;
  readonly price: string | null;
  readonly "filledPrice": string | null;
  readonly "timeInForce": string;
  readonly "idempotencyKey": string | null;
}

export const fetchTransfersOrderRow = async (
  orderId: number,
): Promise<TransfersOrderRow | undefined> =>
  (
    await dbQuery<TransfersOrderRow>(
      `SELECT id, userid, side, status, size, price, "filledPrice", "timeInForce", "idempotencyKey"
         FROM orders WHERE id = $1`,
      [orderId],
    )
  )[0];

/** Órdenes de un usuario (los 400/409/404 no dejan registro). */
export const countTransfersOrders = async (userId: number): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM orders WHERE userid = $1",
    [userId],
  );
  return rows[0]?.count ?? 0;
};

/** Órdenes con una Idempotency-Key dada (UNIQUE(userid, idempotencyKey)). */
export const countTransfersOrdersWithIdempotencyKey = async (
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
// Dinero: helpers de esperados (Decimal desde strings, nunca float)
// ---------------------------------------------------------------------------

/** Cash esperado después de un delta: before ± delta (Decimal, nunca float). */
export const expectedCashAfter = (
  cashBefore: unknown,
  deltaArs: string,
): string => {
  if (typeof cashBefore !== "number") {
    throw new Error(
      `GET /portfolio no devolvió cash numérico (llegó ${String(cashBefore)}).`,
    );
  }
  return new Decimal(String(cashBefore))
    .plus(new Decimal(deltaArs))
    .toFixed(2);
};

/** Assert de dinero serializado: Decimal(String(actual)) === Decimal(expected). */
export const expectMoneyArs = (actual: unknown, expectedArs: string): void => {
  if (typeof actual !== "number") {
    throw new Error(
      `Se esperaba money serializado (number) igual a ${expectedArs}; llegó: ${String(actual)}`,
    );
  }
  expect(new Decimal(String(actual)).toFixed(2)).toBe(expectedArs);
};
