// Support de la suite funcional de LECTURA (Célula C) — tests/functional/read.
//
// DB REAL y AISLADA: READ_DB_URL deriva TEST_DATABASE_URL cambiando sólo el
// nombre de la base para esta suite. La app de test no usa DATABASE_URL runtime.
// La URL queda fijada antes de crear repositorios Prisma (singleton lazy por worker).
//
// Self-reset en beforeAll: corre scripts/test-db-reset.sh con TEST_DB_NAME
// apuntando a ESTA DB (migrate deploy + db/seed.sql).

import { databaseUrlForTestName } from "../../helpers/test-database-url.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express } from "express";
import { Client } from "pg";
import { buildApp } from "../../../src/http/app.js";
import { buildInstrumentsRouter } from "../../../src/http/instruments/instruments-router.js";
import { buildPortfolioRouter } from "../../../src/http/portfolio/portfolio-router.js";
import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../../src/contracts/index.js";
import type { InstrumentQuoteSource } from "../../../src/domain/ports/index.js";
import { PrismaInstrumentRepository } from "../../../src/infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../../../src/infra/prisma/marketdata-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";

const execFileAsync = promisify(execFile);

/** DB de ESTA suite (aislada por célula: el orquestador corre en paralelo). */
export const READ_DB_NAME = "cocos_challenge_read";
export const READ_DB_URL = databaseUrlForTestName(READ_DB_NAME);

// ANTES del primer uso del singleton lazy: URL derivada de TEST_DATABASE_URL.
process.env["DATABASE_URL"] = READ_DB_URL;

/** Resea cocos_challenge_read: migrate deploy + db/seed.sql (idempotente). */
export const resetReadDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: READ_DB_NAME },
  });
};

/**
 * Fuente de cotizaciones LOCAL y determinista para UC-2 (contrato Rev. 2):
 * la suite no sale a Internet ni consulta marketdata — los precios ACTUALES
 * los aporta esta fuente en memoria, construidos como FinancialDecimal
 * desde STRING (AGENTS.md §5.1). Los seeds de BMA/METR/PAMP son
 * EXPLÍCITAMENTE DISTINTOS de los closes del marketdata del seed (925.85,
 * 229.50, 1502.80): así los golden acreditan que la respuesta sale de la
 * fuente y no de un fallback al marketdata histórico. AGRO/PGR/IRCP
 * devuelven `null` = sin cotización computable (se omiten del listado y el
 * cupo se completa con los siguientes candidatos vía offset real del repo);
 * cualquier otro ticker usa la constante por defecto (ambos montos > 0).
 */
interface LocalQuoteSeed {
  readonly priceArs: string;
  readonly previousCloseArs: string;
}

const LOCAL_QUOTE_SEEDS: ReadonlyMap<string, LocalQuoteSeed | null> = new Map([
  ["PAMP", { priceArs: "1111.11", previousCloseArs: "1100.00" }],
  ["METR", { priceArs: "250.50", previousCloseArs: "245.00" }],
  ["BMA", { priceArs: "1600.00", previousCloseArs: "1550.00" }],
  ["AGRO", null],
  ["PGR", null],
  ["IRCP", null],
]);

const DEFAULT_LOCAL_QUOTE: LocalQuoteSeed = {
  priceArs: "123.45",
  previousCloseArs: "100.00",
};

const localQuoteFrom = (
  seed: LocalQuoteSeed,
): { priceArs: FinancialDecimal; previousCloseArs: FinancialDecimal } => ({
  priceArs: new FinancialDecimal(seed.priceArs),
  previousCloseArs: new FinancialDecimal(seed.previousCloseArs),
});

export const buildLocalInstrumentQuoteSource = (): InstrumentQuoteSource => ({
  getCurrentQuote: async (ticker) => {
    // `null` EXPLÍCITO en el map = sin cotización computable (se omite) —
    // distinto de la ausencia del ticker en el map (= constante por defecto).
    const seeded = LOCAL_QUOTE_SEEDS.get(ticker);
    if (seeded === undefined) {
      return localQuoteFrom(DEFAULT_LOCAL_QUOTE);
    }
    return seeded === null ? null : localQuoteFrom(seeded);
  },
});

/**
 * Fuente que marca INDISPONIBILIDAD del proveedor (timeout/rate-limit/5xx):
 * lanza el error de dominio y el borde debe traducirlo a 503 exacto — nunca
 * un listado vacío o parcial como éxito.
 */
export const buildUnavailableInstrumentQuoteSource =
  (): InstrumentQuoteSource => ({
    getCurrentQuote: async () => {
      throw new MarketDataServiceUnavailableError();
    },
  });

/**
 * App de lectura (patrón DI de buildApp): routers de la célula C + repos
 * REALES de la célula B contra cocos_challenge_read, salvo la fuente de
 * cotizaciones de UC-2 — por defecto la fake local determinista; el test
 * puede inyectar un override (casos de indisponibilidad). Portfolio conserva
 * el marketdata REAL (UC-1 no usa cotizaciones actuales). El test compone —
 * src/http/server.ts es del orquestador y no se toca.
 */
export const buildReadTestApp = (
  quoteSource: InstrumentQuoteSource = buildLocalInstrumentQuoteSource(),
): Express => {
  const portfolioRouter = buildPortfolioRouter({
    portfolioRead: new PrismaPortfolioReadRepository(),
    marketdata: new PrismaMarketdataRepository(),
    instruments: new PrismaInstrumentRepository(),
  });
  const instrumentsRouter = buildInstrumentsRouter({
    instruments: new PrismaInstrumentRepository(),
    quotes: quoteSource,
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