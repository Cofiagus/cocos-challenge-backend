// Borde HTTP de UC-2 (GET /api/instruments) contra el caso de uso real con
// puertos FALSOS en memoria: sin DB, sin red, sin Express real (buildApp +
// supertest, patrón de tests/unit/http/error-contract). Cubre la spec Rev. 2:
// listado inicial y query con texto delegados a searchInstruments, precios
// serializados como STRING monetario de 2 decimales (D3, nunca number), 503
// exacto ante MarketDataServiceUnavailableError (sin listado parcial como
// éxito), propagación de errores inesperados al error handler y 400 del borde.
//
// Dinero: FinancialDecimal (64 cifras) desde STRING en los fakes; la salida
// se compara como string canónico.

import request from "supertest";
import type { Express } from "express";
import type { SearchInstrumentsDeps } from "../../../src/application/instruments/search-instruments.js";
import { buildInstrumentsRouter } from "../../../src/http/instruments/instruments-router.js";
import { buildApp } from "../../../src/http/app.js";
import type { InstrumentRecord } from "../../../src/contracts/index.js";
import {
  API_ERROR_CODES,
  ApiErrorBodySchema,
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../../src/contracts/index.js";
import type {
  InstrumentQuoteSource,
  InstrumentRepository,
} from "../../../src/domain/ports/index.js";

// ---------------------------------------------------------------------------
// Puertos falsos con registro de llamadas (igual que el caso de uso)
// ---------------------------------------------------------------------------

const instrument = (
  id: number,
  ticker: string,
  name: string,
): InstrumentRecord => ({ id, ticker, name, type: "ACCIONES" });

const buildCatalog = (
  records: readonly InstrumentRecord[],
): InstrumentRepository & {
  readonly searchByQueryCalls: readonly (readonly [string, number, number])[];
} => {
  const searchByQueryCalls: [string, number, number][] = [];
  const repository: InstrumentRepository = {
    findById: async () => null,
    findByIds: async () => [],
    findByTicker: async () => null,
    searchByQuery: async (query, limit, offset) => {
      searchByQueryCalls.push([query, limit, offset ?? 0]);
      const start = offset ?? 0;
      return records.slice(start, start + limit);
    },
  };
  return { ...repository, searchByQueryCalls };
};

interface QuoteSeed {
  readonly priceArs: string;
  readonly previousCloseArs: string;
}

const buildQuoteSource = (
  quotes: ReadonlyMap<string, QuoteSeed | null>,
): InstrumentQuoteSource & { readonly quoteCalls: readonly string[] } => {
  const quoteCalls: string[] = [];
  const source: InstrumentQuoteSource = {
    getCurrentQuote: async (ticker) => {
      quoteCalls.push(ticker);
      const seeded = quotes.get(ticker) ?? null;
      return seeded === null
        ? null
        : {
            priceArs: new FinancialDecimal(seeded.priceArs),
            previousCloseArs: new FinancialDecimal(seeded.previousCloseArs),
          };
    },
  };
  return { ...source, quoteCalls };
};

/** Falsa fuente que marca indisponibilidad (timeout/rate-limit/5xx). */
const brokenQuoteSource = (): InstrumentQuoteSource => ({
  getCurrentQuote: async () => {
    throw new MarketDataServiceUnavailableError();
  },
});

const buildDeps = (
  instruments: InstrumentRepository,
  quotes: InstrumentQuoteSource,
): SearchInstrumentsDeps => ({ instruments, quotes });

const buildTestApp = (deps: SearchInstrumentsDeps): Express =>
  buildApp([buildInstrumentsRouter(deps)]);

// ---------------------------------------------------------------------------

describe("GET /api/instruments — borde HTTP de la búsqueda (UC-2)", () => {
  it("sin query ⇒ listado inicial: delega ('', default 10) al caso de uso y serializa 200", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
    ]);
    const quotes = buildQuoteSource(
      new Map([["PAMP", { priceArs: "1100.00", previousCloseArs: "1000.00" }]]),
    );

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .expect(200);

    expect(catalog.searchByQueryCalls).toEqual([["", 10, 0]]);
    expect(res.body).toEqual([
      {
        ticker: "PAMP",
        name: "Pampa Holding S.A.",
        type: "ACCIONES",
        price: "1100.00",
        previousClose: "1000.00",
        dailyVariationPct: 10,
      },
    ]);
    expect(typeof res.body[0].price).toBe("string");
    expect(typeof res.body[0].previousClose).toBe("string");
    expect(typeof res.body[0].dailyVariationPct).toBe("number");
  });

  it("query con texto y limit explícito llegan al caso de uso tal cual el borde los validó", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "METR", "MetroGAS S.A."),
    ]);
    const quotes = buildQuoteSource(
      new Map([
        ["PAMP", { priceArs: "1000.00", previousCloseArs: "990.00" }],
        ["METR", { priceArs: "295.00", previousCloseArs: "300.00" }],
      ]),
    );

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .query({ query: "pam", limit: 2 })
      .expect(200);

    // El catálogo sólo matchea por ticker/name: PAMP matchea "pam" (el fake
    // no filtra, pero registra lo que el borde le pasó).
    expect(catalog.searchByQueryCalls).toEqual([["pam", 2, 0]]);
    expect(res.body).toHaveLength(2);
    // Variación negativa ya serializada por el borde: (295 − 300) / 300 × 100 = −1.67.
    const metr = (
      res.body as readonly { ticker: string; dailyVariationPct: number }[]
    ).find((entry) => entry.ticker === "METR");
    expect(metr?.dailyVariationPct).toBe(-1.67);
  });

  it("query sólo espacios ⇒ listado inicial (la spec lo normaliza a '')", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);
    const quotes = buildQuoteSource(
      new Map([["PAMP", { priceArs: "1000.00", previousCloseArs: "990.00" }]]),
    );

    await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .query({ query: "   " })
      .expect(200);

    expect(catalog.searchByQueryCalls).toEqual([["", 10, 0]]);
  });

  it("precios y variación salen de la fuente actual serializados a 2 decimales, sin seed", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "METR", "MetroGAS S.A."),
    ]);
    const quotes = buildQuoteSource(
      new Map([
        ["PAMP", { priceArs: "1234.561", previousCloseArs: "1200.00" }],
        ["METR", { priceArs: "295.005", previousCloseArs: "300.00" }],
      ]),
    );

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .query("query=")
      .expect(200);

    // serializeMoneyArs/serializePct: cuantización HALF_UP a 2 decimales EN Decimal.
    expect(res.body[0]).toMatchObject({
      price: "1234.56",
      previousClose: "1200.00",
      dailyVariationPct: 2.88,
    });
    expect(res.body[1]).toMatchObject({
      price: "295.01",
      previousClose: "300.00",
      dailyVariationPct: -1.67,
    });
    expect(quotes.quoteCalls).toEqual(["PAMP", "METR"]);
  });

  it("ticker sin cotización se omite y el cupo se completa con los siguientes candidatos", async () => {
    const catalog = buildCatalog([
      instrument(1, "BMA", "Banco Macro S.A."),
      instrument(2, "GGAL", "Grupo Financiero Galicia S.A."),
      instrument(3, "CRES", "Cresud S.A.C.I.F."),
    ]);
    const quotes = buildQuoteSource(
      new Map([
        ["BMA", { priceArs: "1500.00", previousCloseArs: "1480.00" }],
        ["GGAL", null],
        ["CRES", { priceArs: "1100.00", previousCloseArs: "1090.00" }],
      ]),
    );

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .query({ limit: 2 })
      .expect(200);

    expect(res.body.map((row: { ticker: string }) => row.ticker)).toEqual([
      "BMA",
      "CRES",
    ]);
    expect(quotes.quoteCalls).toEqual(["BMA", "GGAL", "CRES"]);
  });

  it("serializa el STRING con el centavo exacto por encima de MAX_SAFE_INTEGER (sin pasar por number)", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);
    const quotes = buildQuoteSource(
      new Map([
        [
          "PAMP",
          {
            priceArs: "90071992547409.93",
            previousCloseArs: "90071992547409.90",
          },
        ],
      ]),
    );

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .expect(200);

    expect(res.body[0].price).toBe("90071992547409.93");
    expect(res.body[0].previousClose).toBe("90071992547409.90");
  });

  it("MarketDataServiceUnavailableError ⇒ 503 con body EXACTO de la spec Rev. 2", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);

    const res = await request(
      buildTestApp(buildDeps(catalog, brokenQuoteSource())),
    )
      .get("/api/instruments")
      .expect(503);

    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      error: {
        code: API_ERROR_CODES.MARKET_DATA_SERVICE_UNAVAILABLE,
        message:
          "El servicio de cotizaciones (Yahoo Finance) no está disponible. Intentá nuevamente más tarde.",
      },
    });
  });

  it("una falla después de un éxito parcial NO devuelve listado parcial: 503", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "BMA", "Banco Macro S.A."),
    ]);
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async (ticker) => {
        if (ticker === "PAMP") {
          return {
            priceArs: new FinancialDecimal("1000.00"),
            previousCloseArs: new FinancialDecimal("990.00"),
          };
        }
        throw new MarketDataServiceUnavailableError();
      },
    };

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .expect(503);

    expect(res.body).not.toHaveProperty("0");
    expect(ApiErrorBodySchema.parse(res.body).error.code).toBe(
      API_ERROR_CODES.MARKET_DATA_SERVICE_UNAVAILABLE,
    );
  });

  it("errores inesperados se propagan: 500 INTERNAL_ERROR genérico, sin detalle interno", async () => {
    const catalog: InstrumentRepository = {
      findById: async () => null,
      findByIds: async () => [],
      findByTicker: async () => null,
      searchByQuery: async () => {
        throw new Error("Secreto: tabla users rota.");
      },
    };
    const quotes = buildQuoteSource(new Map());

    const res = await request(buildTestApp(buildDeps(catalog, quotes)))
      .get("/api/instruments")
      .expect(500);

    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      error: {
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: "Error interno del servidor.",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("Secreto");
  });

  it("borde: limit fuera de 1..100 y campo desconocido ⇒ 400 VALIDATION_ERROR, sin tocar el catálogo", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);
    const quotes = buildQuoteSource(new Map());
    const app = buildTestApp(buildDeps(catalog, quotes));

    for (const qs of ["limit=0", "limit=101", "limit=abc", "foo=1"]) {
      const res = await request(app).get(`/api/instruments?${qs}`).expect(400);
      expect(ApiErrorBodySchema.parse(res.body).error.code).toBe(
        API_ERROR_CODES.VALIDATION_ERROR,
      );
    }
    expect(catalog.searchByQueryCalls).toEqual([]);
    expect(quotes.quoteCalls).toEqual([]);
  });
});
