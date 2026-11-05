// Support de la suite funcional de CANCELACIÓN (Célula F) — tests/functional/cancel.
//
// DB REAL y AISLADA: la URL de `cocos_challenge_cancel` se deriva de
// TEST_DATABASE_URL y se recrea por suite con scripts/test-db-reset.sh.
//
// `DATABASE_URL` se fija al destino aislado de esta suite antes de usar Prisma;
// los repositorios y fixtures apuntan a la misma base de test.
//
// Dinero (AGENTS.md): los esperados se computan con Decimal construido desde
// strings y se comparan como Decimal — nunca float.

import { databaseUrlForTestName } from "../../helpers/test-database-url.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Decimal } from "decimal.js";
import type { Express } from "express";
import { Pool, type QueryResultRow } from "pg";
import { buildApp } from "../../../src/http/app.js";
import { buildCancelRouter } from "../../../src/http/cancel/cancel-router.js";
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
export const CANCEL_DB_NAME = "cocos_challenge_cancel";
export const CANCEL_DB_URL = databaseUrlForTestName(CANCEL_DB_NAME);

// ANTES del primer uso del singleton lazy (patrón orders-submit/support.ts).
// Se RESTAURA al cerrar: Jest reutiliza el worker entre archivos y la suite
// no debe dejar un DATABASE_URL distinto para el siguiente archivo.
const PREVIOUS_DATABASE_URL: string | undefined = process.env["DATABASE_URL"];
process.env["DATABASE_URL"] = CANCEL_DB_URL;

/** Resea cocos_challenge_cancel: migrate deploy + db/seed.sql (idempotente). */
export const resetCancelDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: CANCEL_DB_NAME },
  });
};

/**
 * App LOCAL de esta suite (patrón DI de buildApp): el router de cancelación
 * (Célula F) + el router de orders (Célula E, para crear las órdenes NEW /
 * FILLED vía POST) + el router de portfolio (Célula C, para leer el efecto
 * de las reservas desde el test). Repos Prisma reales contra
 * cocos_challenge_cancel. src/http/server.ts es del orquestador y no se toca.
 */
export const buildCancelTestApp = (): Express => {
  const orders = new PrismaOrderRepository();
  const portfolioRead = new PrismaPortfolioReadRepository();
  const instruments = new PrismaInstrumentRepository();
  const marketdata = new PrismaMarketdataRepository();
  return buildApp([
    buildCancelRouter({ orders }),
    buildOrdersRouter({ orders, portfolioRead, instruments, marketdata }),
    buildPortfolioRouter({ portfolioRead, marketdata, instruments }),
  ]);
};

// ---------------------------------------------------------------------------
// pg directo (fixtures + asserts de filas) — misma URL, otro pool
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: CANCEL_DB_URL, max: 1 });

/** Cierra el pool de asserts, el Prisma del singleton y RESTORA el env. */
export const closeCancelDbPool = async (): Promise<void> => {
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

/** Eventos de auditoría de una orden (eventType + reason + metadata jsonb). */
export interface CancelOrderEventRow {
  readonly eventType: string;
  readonly reason: string | null;
  /** jsonb → objeto JSON parseado por pg (unknown: se narrowa en el test). */
  readonly metadata: unknown;
}

export const fetchCancelOrderEvents = async (
  orderId: number,
): Promise<CancelOrderEventRow[]> =>
  dbQuery<CancelOrderEventRow>(
    'SELECT "eventType", reason, metadata FROM order_events WHERE orderid = $1 ORDER BY id ASC',
    [orderId],
  );

/** Fila de `orders` — columnas EXACTAS del schema migrado (ver Célula D db.ts). */
export interface CancelOrderRow {
  readonly id: number;
  readonly userid: number | null;
  readonly side: string | null;
  readonly status: string | null;
  readonly size: string | null;
  readonly price: string | null;
  readonly "filledPrice": string | null;
  readonly "timeInForce": string;
  readonly "idempotencyKey": string | null;
}

export const fetchCancelOrderRow = async (
  orderId: number,
): Promise<CancelOrderRow | undefined> =>
  (
    await dbQuery<CancelOrderRow>(
      `SELECT id, userid, side, status, size, price, "filledPrice", "timeInForce", "idempotencyKey"
         FROM orders WHERE id = $1`,
      [orderId],
    )
  )[0];

/**
 * Fila de orders con status FILLED: movió cash/acciones. Fixture de estado:
 * el size va como STRING monetario (NUMERIC(24,2) — D2) y el precio como
 * string (nunca float).
 */
const insertTestOrder = async (order: {
  readonly userId: number;
  readonly instrumentId: number;
  readonly side: string;
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
 * CASH_IN FILLED (D4): el monto EXACTO va en `size` (columna física de cash)
 * con precio unitario 1.00 — la convención del mapper, que exige esa unidad
 * y deriva el monto del size. Fixture NUEVA: no llama al sizing de acciones
 * ni usa el estilo legacy de precio≠1.00.
 */
export const insertTestCashIn = async (
  userId: number,
  amountArs: string,
): Promise<void> => {
  await insertTestOrder({
    userId,
    instrumentId: SEED_INSTRUMENT_ARS_ID, // ARS: el instrumento del cash (docs §2)
    side: "CASH_IN",
    size: amountArs, // monto exacto con centavos (D4), sin floor
    priceArs: "1.00", // un peso por peso: convención cash del mapper
  });
};

// ---------------------------------------------------------------------------
// Dinero: helpers de esperados (Decimal desde strings, nunca float)
// ---------------------------------------------------------------------------

/** size (acciones) × precio (string ARS) → string ARS exacto con 2 decimales. */
export const costArs = (size: number, priceArs: string): string =>
  new Decimal(String(size))
    .mul(new Decimal(priceArs))
    .toDecimalPlaces(2)
    .toFixed(2);

/**
 * Cash esperado después de un delta: before ± delta (Decimal desde STRINGS,
 * nunca float). El contrato D3 serializa el cash como string de 2 decimales.
 */
export const expectedCashAfter = (
  cashBefore: unknown,
  deltaArs: string,
): string => {
  if (typeof cashBefore !== "string") {
    throw new Error(
      `GET /portfolio no devolvió cash como string monetario (llegó ${String(cashBefore)}).`,
    );
  }
  return new Decimal(cashBefore).plus(new Decimal(deltaArs)).toFixed(2);
};

const MONEY_SERIALIZED_GRAMMAR = /^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$/;

/**
 * Assert de dinero serializado (D3): exige string con formato canónico de
 * exactamente 2 decimales (sin -0.00) y igualdad Decimal contra el esperado.
 */
export const expectMoneyArs = (actual: unknown, expectedArs: string): void => {
  if (typeof actual !== "string") {
    throw new Error(
      `Se esperaba money serializado (string con 2 decimales) igual a ${expectedArs}; llegó: ${String(actual)}`,
    );
  }
  if (!MONEY_SERIALIZED_GRAMMAR.test(actual) || actual === "-0.00") {
    throw new Error(
      `Money serializado fuera del formato canónico (2 decimales): ${actual}`,
    );
  }
  expect(new Decimal(actual).toFixed(2)).toBe(expectedArs);
};
