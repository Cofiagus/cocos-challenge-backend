// Tests funcionales de LECTURA — Célula C (FASE 2).
//
// UC-1 GET /api/users/:userId/portfolio y UC-2 GET /api/instruments?query=
// vía supertest contra buildApp([portfolioRouter, instrumentsRouter]) con
// los repos REALES de la Célula B y el dominio REAL de la A, apuntando a
// la DB propia de la célula: cocos_challenge_read (self-reset en beforeAll,
// ver ./support.ts).
//
// GOLDEN VALUES VERIFICADOS contra la DB (schema migrado + db/seed.sql) el
// 2026-11-02 corriendo db/queries/portfolio.sql + las queries de closes del
// 2023-07-14 (última vela del seed):
//   user 1: cashSettled 753000.00 − cashReserved 125500.00
//           (LOMA BUY NEW 50×710 + BMA BUY NEW 60×1500) ⇒ disponible 627500.00
//   PAMP 40 @ 930 (close 925.85)  ⇒ mv 37034.00 ·  retorno −0.45 %
//   METR 500 @ 250 (close 229.50) ⇒ mv 114750.00 · retorno −8.20 %
//   BMA −10 @ 1540 (close 1502.80)⇒ mv −15028.00 · retorno −2.42 %
//   totalAccountValue = 753000 + 37034 + 114750 − 15028 = 889756.00
//     (cashSettled + Σ marketValue: incluye el cash reservado, así que una
//      orden NEW no lo mueve)
//   previousClose 14-jul: PAMP 921.80 · METR 232.00 · BMA 1520.25
//     ⇒ variación diaria: PAMP +0.44 % · METR −1.08 % · BMA −1.15 %
//   users 2/3/4 existen SIN órdenes (sólo el user 1 tiene filas en orders).
//
// Orden de los its: los golden del user 1 corren PRIMERO (parten del seed
// limpio); después los its que insertan órdenes extra via pg y asumen el
// estado dejado por los previos.

// El import de support fija DATABASE_URL=cocos_challenge_read ANTES de que
// nada construya el PrismaClient (singleton lazy) — ver ./support.ts.
import {
  READ_DB_URL,
  buildReadTestApp,
  insertOrder,
  resetReadDatabase,
} from "./support.js";

import request from "supertest";
import type { Express } from "express";
import { Client } from "pg";
import {
  FinancialDecimal,
  InstrumentSearchResponseSchema,
  PortfolioResponseSchema,
} from "../../../src/contracts/index.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { SEED_USER_EMILIANO_ID } from "../../helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Fixtures locals (ids verificados contra el seed — ver header)
// ---------------------------------------------------------------------------

/** PAMP: instrumento del seed con marketdata (lo usa la reserva de cash). */
const SEED_INSTRUMENT_PAMP_ID = 47;
/** PGR: instrumento del seed SIN marketdata ⇒ precio de referencia null. */
const SEED_INSTRUMENT_PGR_ID = 3;
/** IRCP: ídem PGR (sin marketdata) — lo usa el test de posición cantidad 0. */
const SEED_INSTRUMENT_IRCP_ID = 10;
/** User 2 (jose@test.com): existe en el seed SIN órdenes (verificado). */
const SEED_USER_WITHOUT_ACTIVITY_ID = 2;

const portfolioUrl = (userId: number): string =>
  `/api/users/${userId}/portfolio`;

interface RawRestingOrderInsert {
  readonly userId: number;
  readonly instrumentId: number;
  readonly side: "BUY" | "SELL";
  readonly size: number;
  /** Límite como STRING (AGENTS.md: nunca float). */
  readonly limitPriceArs: string;
}

/**
 * INSERT directo (pg) de una orden LIMIT NEW: la suite no monta el router de
 * envío, así que la reserva se fixturea como fila. `price` es el límite.
 */
const insertRestingOrder = async (
  order: RawRestingOrderInsert,
): Promise<void> => {
  const client = new Client({ connectionString: READ_DB_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO orders
         (instrumentid, userid, side, type, status, size, price, datetime)
       VALUES ($1, $2, $3, 'LIMIT', 'NEW', $4, $5, now())`,
      [
        order.instrumentId,
        order.userId,
        order.side,
        order.size,
        order.limitPriceArs,
      ],
    );
  } finally {
    await client.end();
  }
};

describe("Célula C — endpoints de lectura (DB real: cocos_challenge_read)", () => {
  let app: Express;

  beforeAll(async () => {
    // Self-reset: la suite parte SIEMPRE del seed (migrate deploy + seed).
    await resetReadDatabase();
    app = buildReadTestApp();
  }, 60_000);

  afterAll(async () => {
    // Cierre ordenado del pool del adapter + limpieza del env para el
    // PRÓXIMO archivo del worker (el dotenv de .env.test de las otras
    // suites NO pisa variables ya presentes).
    await getPrismaClient().$disconnect();
    delete process.env["DATABASE_URL"];
  });

  describe("UC-1 — GET /api/users/:userId/portfolio", () => {
    it("user 1 del seed ⇒ golden values verificados (cash/reservas/posiciones/total)", async () => {
      const res = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);

      // El body respeta el contrato de la respuesta.
      expect(() => PortfolioResponseSchema.parse(res.body)).not.toThrow();

      // Disponible = 753000 − 125500; total = 753000 + 37034 + 114750 − 15028.
      // Posiciones ordenadas por instrumentId ASC: BMA(31), PAMP(47), METR(54).
      expect(res.body).toEqual({
        cash: 627_500,
        reservedCash: 125_500,
        totalAccountValue: 889_756,
        positions: [
          {
            ticker: "BMA",
            name: "Banco Macro S.A.",
            quantity: -10,
            marketValue: -15_028,
            priceAvailable: true,
            totalReturnPct: -2.42,
          },
          {
            ticker: "PAMP",
            name: "Pampa Holding S.A.",
            quantity: 40,
            marketValue: 37_034,
            priceAvailable: true,
            totalReturnPct: -0.45,
          },
          {
            ticker: "METR",
            name: "MetroGAS S.A.",
            quantity: 500,
            marketValue: 114_750,
            priceAvailable: true,
            totalReturnPct: -8.2,
          },
        ],
      });
    });

    it("usuario inexistente ⇒ 404 USER_NOT_FOUND con body de error", async () => {
      const res = await request(app)
        .get(portfolioUrl(999_999))
        .expect(404);

      expect(res.body).toEqual({
        error: {
          code: "USER_NOT_FOUND",
          message: expect.any(String),
        },
      });
    });

    it("userId inválido (no numérico) ⇒ 400 VALIDATION_ERROR", async () => {
      const res = await request(app).get("/api/users/abc/portfolio").expect(400);

      expect(res.body).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: expect.any(String),
        },
      });
    });

    it("user sin actividad (user 2, sin órdenes) ⇒ todo en cero y positions []", async () => {
      const res = await request(app)
        .get(portfolioUrl(SEED_USER_WITHOUT_ACTIVITY_ID))
        .expect(200);

      expect(res.body).toEqual({
        cash: 0,
        reservedCash: 0,
        totalAccountValue: 0,
        positions: [],
      });
    });

    it("posición SIN precio (PGR sin marketdata) ⇒ marketValue null, priceAvailable false y NO suma al total", async () => {
      // Antes del insert: el total golden del seed.
      const before = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);
      expect(before.body.totalAccountValue).toBe(889_756);

      // INSERT directo (pg): BUY FILLED de PGR (id 3, SIN marketdata) 10 @ 500.
      await insertOrder({
        userId: SEED_USER_EMILIANO_ID,
        instrumentId: SEED_INSTRUMENT_PGR_ID,
        side: "BUY",
        size: 10,
        priceArs: "500.00",
      });

      const res = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);

      // Tipado via contrato (sin any): valida la forma Y tipa el body.
      const body = PortfolioResponseSchema.parse(res.body);

      // La posición aparece PRIMERA (instrumentId 3 < 31), con precio null.
      expect(body.positions).toHaveLength(4);
      expect(body.positions[0]).toEqual({
        ticker: "PGR",
        name: "Phoenix Global Resources",
        quantity: 10,
        marketValue: null,
        priceAvailable: false,
        totalReturnPct: null,
      });

      // El cash cayó 5000 (la BUY FILLED movió plata)…
      expect(body.cash).toBe(622_500);
      // …y el total cayó EXACTO esa plata: la posición sin precio aporta 0
      // (las null NO suman — DECISIONS.md; sin fallback a costo). Total
      // calculado: 889756 − 5000 = 884756 = 748000 + 37034 + 114750 − 15028
      // (748000 = cashSettled: la compra FILLED sí saca patrimonio).
      expect(body.totalAccountValue).toBe(884_756);
    });

    it("posición de cantidad 0 (BUY+SELL FILLED que se cancelan) ⇒ oculta", async () => {
      // INSERT directo (pg): 5 compradas + 5 vendidas de IRCP (id 10) ⇒ qty 0.
      await insertOrder({
        userId: SEED_USER_EMILIANO_ID,
        instrumentId: SEED_INSTRUMENT_IRCP_ID,
        side: "BUY",
        size: 5,
        priceArs: "100.00",
      });
      await insertOrder({
        userId: SEED_USER_EMILIANO_ID,
        instrumentId: SEED_INSTRUMENT_IRCP_ID,
        side: "SELL",
        size: 5,
        priceArs: "100.00",
      });

      const res = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);

      // Tipado via contrato (sin any).
      const body = PortfolioResponseSchema.parse(res.body);

      // Quedan las 4 con qty ≠ 0 (PGR del it anterior incluida); IRCP ausente.
      expect(body.positions.map((position) => position.ticker)).toEqual([
        "PGR",
        "BMA",
        "PAMP",
        "METR",
      ]);

      // Cash neta del par: −500 + 500 = 0 y ninguna mv nueva ⇒ total
      // idéntico al del it anterior (884756: el cash ya cargó la BUY de PGR).
      expect(body.cash).toBe(622_500);
      expect(body.totalAccountValue).toBe(884_756);
    });

    it("orden NEW (reserva de cash) ⇒ el total NO cambia; cash baja y reservedCash sube", async () => {
      const before = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);
      const beforeBody = PortfolioResponseSchema.parse(before.body);

      // INSERT directo (pg): BUY LIMIT NEW 10 @ 500 ⇒ reserva 5000.
      await insertRestingOrder({
        userId: SEED_USER_EMILIANO_ID,
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "BUY",
        size: 10,
        limitPriceArs: "500.00",
      });

      const after = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);
      const afterBody = PortfolioResponseSchema.parse(after.body);

      // Reservar cash lo saca del disponible pero NO del patrimonio. `cash` y
      // `reservedCash` son MoneyArs (string): la aritmética va por
      // FinancialDecimal y se compara el string cuantizado, nunca un number.
      expect(afterBody.cash).toBe(
        new FinancialDecimal(beforeBody.cash).minus("5000").toFixed(2),
      );
      expect(afterBody.reservedCash).toBe(
        new FinancialDecimal(beforeBody.reservedCash).plus("5000").toFixed(2),
      );
      expect(afterBody.totalAccountValue).toBe(beforeBody.totalAccountValue);

    });
  });

  describe("UC-2 — GET /api/instruments?query=", () => {
    it("búsqueda por ticker parcial case-insensitive ('pam') ⇒ PAMP con precio/variación golden", async () => {
      const res = await request(app).get("/api/instruments?query=pam").expect(200);

      // El body respeta el contrato de la respuesta.
      expect(() => InstrumentSearchResponseSchema.parse(res.body)).not.toThrow();

      // Único match de '%pam%' (verificado contra la DB), close/previousClose
      // del 2023-07-14: (925.85 − 921.80) / 921.80 × 100 = 0.44.
      expect(res.body).toEqual([
        {
          ticker: "PAMP",
          name: "Pampa Holding S.A.",
          type: "ACCIONES",
          price: 925.85,
          previousClose: 921.8,
          dailyVariationPct: 0.44,
        },
      ]);
    });

    it("búsqueda por NAME parcial ('Holding') ⇒ los 3 verificados, orden por ticker", async () => {
      const res = await request(app)
        .get("/api/instruments?query=Holding")
        .expect(200);

      // Tipado via contrato (sin any) + '%Holding%' sobre name (verificado):
      // CVH, HAVA y PAMP.
      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results.map((instrument) => instrument.ticker)).toEqual([
        "CVH",
        "HAVA",
        "PAMP",
      ]);
    });

    it("dailyVariationPct exacto del último snapshot (METR y BMA del 14-jul)", async () => {
      // METR: (229.50 − 232.00) / 232.00 × 100 = −1.08.
      const metr = await request(app).get("/api/instruments?query=metr").expect(200);
      expect(metr.body[0]).toEqual({
        ticker: "METR",
        name: "MetroGAS S.A.",
        type: "ACCIONES",
        price: 229.5,
        previousClose: 232,
        dailyVariationPct: -1.08,
      });

      // BMA: (1502.80 − 1520.25) / 1520.25 × 100 = −1.15.
      const bma = await request(app).get("/api/instruments?query=bma").expect(200);
      expect(bma.body[0]).toEqual({
        ticker: "BMA",
        name: "Banco Macro S.A.",
        type: "ACCIONES",
        price: 1502.8,
        previousClose: 1520.25,
        dailyVariationPct: -1.15,
      });
    });

    it("límite por defecto: query con 59 matches ⇒ 20 resultados ordenados por ticker", async () => {
      const res = await request(app).get("/api/instruments?query=a").expect(200);

      // Tipado via contrato (sin any). '%a%' (ticker O name, sin MONEDA) ⇒
      // 59 matches (verificado); el default del contrato recorta a 20,
      // ORDER BY ticker.
      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results).toHaveLength(20);
      expect(results.map((instrument) => instrument.ticker)).toEqual([
        "AGRO",
        "ALUA",
        "AUSO",
        "BBAR",
        "BHIP",
        "BMA",
        "BOLT",
        "BPAT",
        "BYMA",
        "CADO",
        "CAPX",
        "CARC",
        "CECO2",
        "CELU",
        "CEPU",
        "CGPA2",
        "COME",
        "CRES",
        "CTIO",
        "CVH",
      ]);
    });

    it("limit explícito ('?query=banco&limit=2') ⇒ los 2 primeros por ticker", async () => {
      const res = await request(app)
        .get("/api/instruments?query=banco&limit=2")
        .expect(200);

      // Tipado via contrato (sin any). '%banco%' ⇒ BBAR, BHIP, BMA, BPAT
      // (verificado); LIMIT 2 ⇒ los 2 primeros por ticker.
      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results.map((instrument) => instrument.ticker)).toEqual([
        "BBAR",
        "BHIP",
      ]);
    });

    it("MONEDA excluida de la búsqueda ('peso' y 'ARS' ⇒ [])", async () => {
      // '%peso%' sólo matchea ARS/PESOS (id 66, MONEDA) y '%ARS%' ídem:
      // searchByQuery las deja fuera ⇒ respuesta vacía.
      const peso = await request(app).get("/api/instruments?query=peso").expect(200);
      expect(peso.body).toEqual([]);

      const ars = await request(app).get("/api/instruments?query=ARS").expect(200);
      expect(ars.body).toEqual([]);
    });

    it("instrumento sin marketdata (PGR/IRCP) ⇒ price null, previousClose null, variación null", async () => {
      const pgr = await request(app).get("/api/instruments?query=pgr").expect(200);
      expect(pgr.body).toEqual([
        {
          ticker: "PGR",
          name: "Phoenix Global Resources",
          type: "ACCIONES",
          price: null,
          previousClose: null,
          dailyVariationPct: null,
        },
      ]);

      const ircp = await request(app).get("/api/instruments?query=ircp").expect(200);
      expect(ircp.body).toEqual([
        {
          ticker: "IRCP",
          name: "IRSA Propiedades Comerciales S.A.",
          type: "ACCIONES",
          price: null,
          previousClose: null,
          dailyVariationPct: null,
        },
      ]);
    });

    it("query vacía '?query=' ⇒ 400 VALIDATION_ERROR", async () => {
      const res = await request(app).get("/api/instruments?query=").expect(400);

      expect(res.body).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: expect.any(String),
        },
      });
    });

    it("query ausente '/api/instruments' ⇒ 400 VALIDATION_ERROR", async () => {
      const res = await request(app).get("/api/instruments").expect(400);

      expect(res.body).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: expect.any(String),
        },
      });
    });
  });
});