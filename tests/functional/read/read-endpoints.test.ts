// Tests funcionales de LECTURA — Célula C (FASE 2).
//
// UC-1 GET /api/users/:userId/portfolio y UC-2 GET /api/instruments?query=
// vía supertest contra buildApp([portfolioRouter, instrumentsRouter]) con
// los repos REALES de la Célula B y el dominio REAL de la A, apuntando a
// la DB propia de la célula: cocos_challenge_read (self-reset en beforeAll,
// ver ./support.ts).
//
// UC-2 (contrato Rev. 2, spec instruments-current-quotes): los PRECIOS
// ACTUALES vienen de la fuente fake LOCAL de ./support.ts — sin Internet y
// sin marketdata (sus valores son explícitamente distintos de los closes del
// seed para acreditar que no hay fallback). El catálogo (filtro/orden/
// exclusión de MONEDA y offset interno) sigue siendo el repo real contra la
// DB seedeada; la app del caso 503 se compone con la fuente indisponible del
// mismo support.
//
// GOLDEN VALUES VERIFICADOS contra la DB (schema migrado + db/seed.sql) el
// 2026-11-02 corriendo db/queries/portfolio.sql + las queries de closes del
// 2023-07-14 (última vela del seed). Formas JSON según D3 (spec
// datos-financieros-grandes-montos.md): dinero de SALIDA como string con
// exactamente 2 decimales y quantity como string entero — mismos valores
// económicos del golden, cambia sólo la representación:
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
  buildUnavailableInstrumentQuoteSource,
  READ_DB_URL,
  buildReadTestApp,
  insertOrder,
  resetReadDatabase,
} from "./support.js";

import request from "supertest";
import type { Express } from "express";
import { Client } from "pg";
import {
  API_ERROR_CODES,
  FinancialDecimal,
  InstrumentSearchResponseSchema,
  MarketDataServiceUnavailableError,
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
        cash: "627500.00",
        reservedCash: "125500.00",
        totalAccountValue: "889756.00",
        positions: [
          {
            ticker: "BMA",
            name: "Banco Macro S.A.",
            quantity: "-10",
            marketValue: "-15028.00",
            priceAvailable: true,
            totalReturnPct: -2.42,
          },
          {
            ticker: "PAMP",
            name: "Pampa Holding S.A.",
            quantity: "40",
            marketValue: "37034.00",
            priceAvailable: true,
            totalReturnPct: -0.45,
          },
          {
            ticker: "METR",
            name: "MetroGAS S.A.",
            quantity: "500",
            marketValue: "114750.00",
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
        cash: "0.00",
        reservedCash: "0.00",
        totalAccountValue: "0.00",
        positions: [],
      });
    });

    it("posición SIN precio (PGR sin marketdata) ⇒ marketValue null, priceAvailable false y NO suma al total", async () => {
      // Antes del insert: el total golden del seed.
      const before = await request(app)
        .get(portfolioUrl(SEED_USER_EMILIANO_ID))
        .expect(200);
      expect(before.body.totalAccountValue).toBe("889756.00");

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
        quantity: "10",
        marketValue: null,
        priceAvailable: false,
        totalReturnPct: null,
      });

      // El cash cayó 5000 (la BUY FILLED movió plata)…
      expect(body.cash).toBe("622500.00");
      // …y el total cayó EXACTO esa plata: la posición sin precio aporta 0
      // (las null NO suman — DECISIONS.md; sin fallback a costo). Total
      // calculado: 889756 − 5000 = 884756 = 748000 + 37034 + 114750 − 15028
      // (748000 = cashSettled: la compra FILLED sí saca patrimonio).
      expect(body.totalAccountValue).toBe("884756.00");
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
      expect(body.cash).toBe("622500.00");
      expect(body.totalAccountValue).toBe("884756.00");
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

  describe("UC-2 — GET /api/instruments?query= (contrato Rev. 2)", () => {
    // Cotizaciones de la fuente fake LOCAL de ./support.ts (sin Internet y
    // sin marketdata — valores EXPLÍCITAMENTE distintos de los closes del
    // seed 925.85/921.80 · 229.50/232.00 · 1502.80/1520.25):
    //   PAMP 1111.11/1100.00 · METR 250.50/245.00 · BMA 1600.00/1550.00
    //   resto de tickers constante 123.45/100.00 · AGRO/PGR/IRCP `null`
    //   (se omiten y el cupo se completa con los siguientes candidatos,
    //   offset REAL del repo Prisma). La variación es
    //   (price − previousClose) / previousClose × 100, calculada en
    //   FinancialDecimal y cuantizada a 2 decimales por serializePct.
    // Dinero de SALIDA (D3): price/previousClose STRING monetario de 2
    // decimales; dailyVariationPct number.

    /** Resultado de la constante por defecto del fake (123.45/100.00). */
    const fakeDefaultResult = (ticker: string, name: string) => ({
      ticker,
      name,
      type: "ACCIONES",
      price: "123.45",
      previousClose: "100.00",
      dailyVariationPct: 23.45,
    });

    /**
     * Listado inicial con default 10 (orden ticker asc del repo real): los
     * primeros 10 tickers del catálogo sin MONEDA son AGRO..CADO, pero AGRO
     * tiene quote `null` en el fake ⇒ se OMITE y el cupo (offset interno
     * REAL contra la DB) se completa con el siguiente candidato (CAPX).
     */
    const INITIAL_LISTING_TEN = [
      fakeDefaultResult("ALUA", "Aluar Aluminio Argentino S.A.I.C."),
      fakeDefaultResult("AUSO", "Autopistas del Sol"),
      fakeDefaultResult("BBAR", "Banco Frances"),
      fakeDefaultResult("BHIP", "Banco Hipotecario S.A."),
      {
        ticker: "BMA",
        name: "Banco Macro S.A.",
        type: "ACCIONES",
        price: "1600.00",
        previousClose: "1550.00",
        dailyVariationPct: 3.23,
      },
      fakeDefaultResult("BOLT", "Boldt S.A."),
      fakeDefaultResult("BPAT", "Banco Patagonia"),
      fakeDefaultResult("BYMA", "Bolsas y Mercados Argentinos S.A."),
      fakeDefaultResult("CADO", "Carlos Casado"),
      fakeDefaultResult("CAPX", "Capex S.A."),
    ];

    it("ticker parcial case-insensitive ('pam') ⇒ PAMP con la cotización del fake local, NO la del marketdata del seed", async () => {
      const res = await request(app).get("/api/instruments?query=pam").expect(200);

      // El body respeta el contrato de la respuesta (money string 2dp,
      // pct number; sin cotización computable el instrumento se OMITE).
      expect(() => InstrumentSearchResponseSchema.parse(res.body)).not.toThrow();

      // (1111.11 − 1100.00) / 1100.00 × 100 = 1.01.
      expect(res.body).toEqual([
        {
          ticker: "PAMP",
          name: "Pampa Holding S.A.",
          type: "ACCIONES",
          price: "1111.11",
          previousClose: "1100.00",
          dailyVariationPct: 1.01,
        },
      ]);
    });

    it("name parcial ('Holding') ⇒ CVH, HAVA y PAMP ordenados por ticker; los sin seed usan la constante del fake", async () => {
      const res = await request(app)
        .get("/api/instruments?query=Holding")
        .expect(200);

      // Tipado via contrato (sin any) + '%Holding%' sobre name (verificado):
      // CVH, HAVA y PAMP. CVH/HAVA no tienen seed en el fake ⇒ constante
      // 123.45/100.00 (variación 23.45 %); PAMP conserva su valor del fake.
      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results).toEqual([
        fakeDefaultResult("CVH", "Cablevision Holding"),
        fakeDefaultResult("HAVA", "Havanna Holding"),
        {
          ticker: "PAMP",
          name: "Pampa Holding S.A.",
          type: "ACCIONES",
          price: "1111.11",
          previousClose: "1100.00",
          dailyVariationPct: 1.01,
        },
      ]);
    });

    it("query ausente ⇒ listado inicial con default 10, ticker ASC, AGRO omitido (quote null) y cupo completado vía offset REAL del repo", async () => {
      const res = await request(app).get("/api/instruments").expect(200);

      // Tipado via contrato (sin any): price/previousClose son STRING y
      // dailyVariationPct number OBLIGATORIOS — un null ya no parsea.
      const results = InstrumentSearchResponseSchema.parse(res.body);

      expect(results).toHaveLength(10);
      expect(results.map((instrument) => instrument.ticker)).toEqual([
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
      ]);
      // El body completo respeta el orden y los valores del fake (BMA lleva
      // su seed del fake, NO el close del marketdata del seed).
      expect(res.body).toEqual(INITIAL_LISTING_TEN);
    });

    it.each([
      ["query vacía", "/api/instruments?query="],
      ["query sólo espacios", "/api/instruments?query=%20%20"],
    ])("%s ⇒ 200 listado inicial (NO 400): '' tras trim = listado inicial", async (_case, url) => {
      const res = await request(app).get(url).expect(200);

      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results).toHaveLength(10);
      expect(res.body).toEqual(INITIAL_LISTING_TEN);
    });

    it("query 'a' con limit 10 ⇒ 10 resultados ordenados sin AGRO: el cupo se completa con los siguientes candidatos (offset REAL)", async () => {
      // '%a%' (ticker O name) matchea 59 instrumentos sin MONEDA (verificado
      // contra la DB); los primeros 10 por ticker son AGRO..CADO. AGRO tiene
      // quote `null` ⇒ se omite y la página siguiente (offset interno real
      // del repo Prisma) aporta CAPX para completar el cupo.
      const res = await request(app)
        .get("/api/instruments?query=a&limit=10")
        .expect(200);

      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results).toHaveLength(10);
      expect(results.map((instrument) => instrument.ticker)).toEqual([
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
      ]);
    });

    it("limit máximo (100) aceptado ⇒ los 56 con cotización del fake (59 matches de '%a%' menos AGRO/PGR/IRCP null)", async () => {
      const res = await request(app)
        .get("/api/instruments?query=a&limit=100")
        .expect(200);

      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results).toHaveLength(56);
      expect(results.at(0)?.ticker).toBe("ALUA");
      expect(results.at(-1)?.ticker).toBe("YPFD");
    });

    it("limit explícito ('?query=banco&limit=2') ⇒ los 2 primeros por ticker", async () => {
      const res = await request(app)
        .get("/api/instruments?query=banco&limit=2")
        .expect(200);

      // Tipado via contrato (sin any). '%banco%' ⇒ BBAR, BHIP, BMA, BPAT
      // (verificado); LIMIT 2 ⇒ los 2 primeros por ticker, con la constante
      // del fake.
      const results = InstrumentSearchResponseSchema.parse(res.body);
      expect(results).toEqual([
        fakeDefaultResult("BBAR", "Banco Frances"),
        fakeDefaultResult("BHIP", "Banco Hipotecario S.A."),
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

    it("query sin matches ('zzzz') ⇒ [] (sin error)", async () => {
      const res = await request(app)
        .get("/api/instruments?query=zzzz")
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it("ticker sin cotización computable (PGR/IRCP: quote null) ⇒ se OMITE del listado y la query exacta da []", async () => {
      // Política aprobada de la spec Rev. 2: sin cotización se omite el
      // instrumento (sin fallback al seed ni precios null en la respuesta).
      const pgr = await request(app).get("/api/instruments?query=pgr").expect(200);
      expect(pgr.body).toEqual([]);

      const ircp = await request(app).get("/api/instruments?query=ircp").expect(200);
      expect(ircp.body).toEqual([]);
    });

    it("sin nulls ni fallback al marketdata del seed: price/previousClose SIEMPRE string 2dp, pct number, y los closes del seed no aparecen", async () => {
      const res = await request(app)
        .get("/api/instruments?query=a&limit=100")
        .expect(200);
      const results = InstrumentSearchResponseSchema.parse(res.body);

      for (const result of results) {
        // Dinero de salida SIEMPRE string monetario de 2 decimales (D3):
        // nunca number ni null; la variación sí es number (2 decimales).
        expect(result.price).toMatch(/^\d+\.\d{2}$/u);
        expect(result.previousClose).toMatch(/^\d+\.\d{2}$/u);
        expect(typeof result.dailyVariationPct).toBe("number");
        expect(Number(result.price)).toBeGreaterThan(0);
        expect(Number(result.previousClose)).toBeGreaterThan(0);
      }

      // Los valores del marketdata del seed (closes del 2023-07-14) NO
      // aparecen en la búsqueda: la respuesta sale de la fuente fake local.
      const seedCloses = ["925.85", "921.80", "229.50", "232.00", "1502.80", "1520.25"];
      const listedPrices = new Set(results.flatMap((r) => [r.price, r.previousClose]));
      for (const seedClose of seedCloses) {
        expect(listedPrices.has(seedClose)).toBe(false);
      }
    });

    it.each([
      ["limit 0 (mínimo 1)", "/api/instruments?query=a&limit=0"],
      ["limit 101 (máximo 100)", "/api/instruments?query=a&limit=101"],
      ["limit no entero", "/api/instruments?query=a&limit=1.5"],
      ["limit no numérico", "/api/instruments?query=a&limit=abc"],
      ["parámetro desconocido (strict)", "/api/instruments?query=a&foo=1"],
      ["query duplicada", "/api/instruments?query=a&query=b"],
    ])("query inválida: %s ⇒ 400 VALIDATION_ERROR", async (_case, url) => {
      const res = await request(app).get(url).expect(400);

      expect(res.body).toEqual({
        error: {
          code: API_ERROR_CODES.VALIDATION_ERROR,
          message: expect.any(String),
        },
      });
    });

    it("indisponibilidad del proveedor (fake que lanza MarketDataServiceUnavailableError) ⇒ 503 exacto, NUNCA listado vacío/parcial como éxito", async () => {
      // Override de la fuente: la app del caso 503 se compone aparte (la
      // default usa la fake local). query=pam SÍ matchea PAMP: si el borde
      // disfrazara la falla, devolvería [] o un parcial 200 — prohibido.
      const unavailableApp = buildReadTestApp(
        buildUnavailableInstrumentQuoteSource(),
      );
      const res = await request(unavailableApp)
        .get("/api/instruments?query=pam")
        .expect(503);

      // Body EXACTO del contrato (código + mensaje literal de la spec Rev. 2).
      expect(res.body).toEqual({
        error: {
          code: API_ERROR_CODES.MARKET_DATA_SERVICE_UNAVAILABLE,
          message: new MarketDataServiceUnavailableError().message,
        },
      });
      // Sin listado disfrazado de éxito: la respuesta no es un array.
      expect(Array.isArray(res.body)).toBe(false);
    });
  });
});
