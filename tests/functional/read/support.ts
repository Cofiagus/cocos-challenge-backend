// Support de la suite funcional de LECTURA (Célula C) — tests/functional/read.
//
// DB REAL y AISLADA: cocos_challenge_read en el cluster local (localhost:5433,
// auth trust). Las demás células corren contra cocos_challenge_test vía
// .env.test — ESTA suite NO carga .env.test: fija DATABASE_URL explícito a SU
// DB antes de que ningún repositorio construya el PrismaClient (el singleton
// de src/lib/prisma-client.ts es lazy, pero vive POR PROCESO del worker).
//
// Self-reset en beforeAll: scripts/test-db-reset.sh con TEST_DB_NAME — el
// MISMO flujo de tests/helpers/dbReset.ts (migrate deploy + db/seed.sql),
// apuntando a ESTA DB.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express } from "express";
import { Client } from "pg";
import { buildApp } from "../../../src/http/app.js";
import { buildInstrumentsRouter } from "../../../src/http/instruments/instruments-router.js";
import { buildPortfolioRouter } from "../../../src/http/portfolio/portfolio-router.js";
import { PrismaInstrumentRepository } from "../../../src/infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../../../src/infra/prisma/marketdata-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";

const execFileAsync = promisify(execFile);

/** DB de ESTA suite (aislada por célula: el orquestador corre en paralelo). */
export const READ_DB_NAME = "cocos_challenge_read";
export const READ_DB_URL = `postgresql://postgres@localhost:5433/${READ_DB_NAME}`;

// ANTES del primer uso del singleton lazy: la URL de ESTA DB (nunca la de
// .env.test, que apunta a cocos_challenge_test — la DB de la célula B).
process.env["DATABASE_URL"] = READ_DB_URL;

/** Resea cocos_challenge_read: migrate deploy + db/seed.sql (idempotente). */
export const resetReadDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: READ_DB_NAME },
  });
};

/**
 * App de lectura con TODO real (patrón DI de buildApp): routers de la célula
 * C + repos reales de la célula B contra cocos_challenge_read. El test
 * compone — src/http/server.ts es del orquestador y no se toca.
 */
export const buildReadTestApp = (): Express => {
  const portfolioRouter = buildPortfolioRouter({
    portfolioRead: new PrismaPortfolioReadRepository(),
    marketdata: new PrismaMarketdataRepository(),
    instruments: new PrismaInstrumentRepository(),
  });
  const instrumentsRouter = buildInstrumentsRouter({
    instruments: new PrismaInstrumentRepository(),
    marketdata: new PrismaMarketdataRepository(),
  });
  return buildApp([portfolioRouter, instrumentsRouter]);
};

/** Orden a insertar directo con pg (fixture de estado, sin repos de B). */
export interface RawOrderInsert {
  readonly userId: number;
  readonly instrumentId: number;
  readonly side: "BUY" | "SELL";
  readonly size: number;
  /** Dinero como STRING (AGENTS.md: nunca float; pg lo castea a numeric). */
  readonly priceArs: string;
}

/**
 * INSERT directo en orders con el cliente pg — helper PROPIO de esta suite
 * (el flujo de envío de órdenes es de la célula D; acá sólo se fixturea
 * estado: una FILLED más para el user 1). type=LIMIT, status=FILLED y
 * timeInForce=GTC (default del schema migrado); el resto de las columnas
 * nuevas (filledPrice/filledAt/idempotencyKey) va NULL, como en el seed.
 */
export const insertOrder = async (order: RawOrderInsert): Promise<number> => {
  const client = new Client({ connectionString: READ_DB_URL });
  await client.connect();
  try {
    const result = await client.query<{ readonly id: number }>(
      `INSERT INTO orders
         (instrumentid, userid, side, type, status, size, price, datetime)
       VALUES ($1, $2, $3, 'LIMIT', 'FILLED', $4, $5, now())
       RETURNING id`,
      [
        order.instrumentId,
        order.userId,
        order.side,
        order.size,
        order.priceArs,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT de orders no devolvió id (fixture rota).");
    }
    return row.id;
  } finally {
    await client.end();
  }
};