// Tests unitarios del caso de uso searchInstruments (UC-2): puertos FALSOS en
// memoria, sin DB, sin red y sin Express. Cubren la delegación del filtro al
// catálogo, la iteración interna por offset (páginas del tamaño restante), la
// política aprobada de omitir sin cotización y completar el cupo, la
// variación en FinancialDecimal (64 cifras; positiva y negativa), el aborto
// tipado ante MarketDataServiceUnavailableError después de éxito parcial, la
// propagación de errores inesperados, la concurrencia acotada a 1 y la
// ausencia de fallback al seed.
//
// Dinero: FinancialDecimal (precisión 64) construido desde STRING (D1/D3),
// nunca el Decimal base de decimal.js ni un number.

import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../../src/contracts/index.js";
import type { InstrumentRecord } from "../../../src/contracts/index.js";
import { searchInstruments } from "../../../src/application/instruments/search-instruments.js";
import type {
  InstrumentSearchView,
  SearchInstrumentsDeps,
} from "../../../src/application/instruments/search-instruments.js";
import type {
  InstrumentQuoteSource,
  InstrumentRepository,
} from "../../../src/domain/ports/index.js";

// ---------------------------------------------------------------------------
// Builders de insumos (dinero desde string, nunca float)
// ---------------------------------------------------------------------------

const instrument = (
  id: number,
  ticker: string,
  name: string,
  type: InstrumentRecord["type"] = "ACCIONES",
): InstrumentRecord => ({ id, ticker, name, type });

interface QuoteSeed {
  readonly priceArs: string;
  readonly previousCloseArs: string;
}

const quote = (seed: QuoteSeed): {
  priceArs: FinancialDecimal;
  previousCloseArs: FinancialDecimal;
} => ({
  priceArs: new FinancialDecimal(seed.priceArs),
  previousCloseArs: new FinancialDecimal(seed.previousCloseArs),
});

// ---------------------------------------------------------------------------
// Puertos falsos con registro de llamadas
// ---------------------------------------------------------------------------

const buildCatalog = (
  records: readonly InstrumentRecord[],
): InstrumentRepository & {
  /** (query, limit, offset) recibido en cada llamada. */
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
  return {
    ...repository,
    searchByQueryCalls,
  };
};

interface QuoteSourceSeed {
  readonly quotes: ReadonlyMap<string, QuoteSeed | null>;
  /** Si está, lanza al recibir ese ticker (después de un éxito previo). */
  readonly throwOnTicker?: string;
}

const buildQuoteSource = (
  seed: QuoteSourceSeed,
): InstrumentQuoteSource & {
  readonly quoteCalls: readonly string[];
  /** Máximo de llamadas en simultáneo observado. */
  readonly maxConcurrentCalls: () => number;
} => {
  const quoteCalls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const source: InstrumentQuoteSource = {
    getCurrentQuote: async (ticker) => {
      quoteCalls.push(ticker);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        if (seed.throwOnTicker === ticker) {
          throw new Error("Falla inesperada del proveedor.");
        }
        const seeded = seed.quotes.get(ticker) ?? null;
        return seeded === null ? null : quote(seeded);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { ...source, quoteCalls, maxConcurrentCalls: () => maxInFlight };
};

const buildDeps = (
  catalog: InstrumentRepository,
  quotes: InstrumentQuoteSource,
): SearchInstrumentsDeps => ({ instruments: catalog, quotes });

// ---------------------------------------------------------------------------
// Lectura del resultado (sin `!`: el test falla con un mensaje claro)
// ---------------------------------------------------------------------------

const viewAt = (
  views: readonly InstrumentSearchView[],
  index: number,
): InstrumentSearchView => {
  const view = views[index];
  if (view === undefined) {
    throw new Error(`Falta la vista ${index} en el resultado.`);
  }
  return view;
};

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

describe("searchInstruments — caso de uso de búsqueda con cotizaciones", () => {
  it("delega el filtro al catálogo (query y cupo inicial = limit, sin consultar Yahoo de más)", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "METR", "MetroGAS S.A."),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["PAMP", { priceArs: "1000.00", previousCloseArs: "900.00" }],
        ["METR", { priceArs: "300.00", previousCloseArs: "310.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "pamp metr",
      limit: 2,
    });

    expect(catalog.searchByQueryCalls).toEqual([["pamp metr", 2, 0]]);
    expect(views).toHaveLength(2);
  });

  it("query vacía se delega igual (listado inicial) y preserva el orden ticker asc del repositorio", async () => {
    const catalog = buildCatalog([
      instrument(1, "ALUA", "Aluar Aluminio Argentino S.A.I.C."),
      instrument(2, "BMA", "Banco Macro S.A."),
      instrument(3, "CRES", "Cresud S.A.C.I.F."),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["ALUA", { priceArs: "800.00", previousCloseArs: "790.00" }],
        ["BMA", { priceArs: "1500.00", previousCloseArs: "1480.00" }],
        ["CRES", { priceArs: "1100.00", previousCloseArs: "1110.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 3,
    });

    expect(catalog.searchByQueryCalls).toEqual([["", 3, 0]]);
    expect(views.map((view) => view.ticker)).toEqual(["ALUA", "BMA", "CRES"]);
    expect(views.map((view) => view.name)).toEqual([
      "Aluar Aluminio Argentino S.A.I.C.",
      "Banco Macro S.A.",
      "Cresud S.A.C.I.F.",
    ]);
  });

  it("los precios vienen de la fuente actual, no de ningún seed del dataset", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);
    // El catálogo (dataset estático) NO aporta precios: sólo ticker/name/type.
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["PAMP", { priceArs: "1234.56", previousCloseArs: "1200.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 1,
    });

    const pamp = viewAt(views, 0);
    expect(pamp.ticker).toBe("PAMP");
    expect(pamp.priceArs.toFixed(2)).toBe("1234.56");
    expect(pamp.previousCloseArs.toFixed(2)).toBe("1200.00");
    expect(pamp.type).toBe("ACCIONES");
  });

  it("variación diaria = (price − previousClose) / previousClose × 100, positiva y negativa", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "METR", "MetroGAS S.A."),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["PAMP", { priceArs: "1100.00", previousCloseArs: "1000.00" }],
        ["METR", { priceArs: "295.00", previousCloseArs: "300.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 2,
    });

    // (1100 − 1000) / 1000 × 100 = 10 %.
    const pamp = viewAt(views, 0);
    expect(pamp.dailyVariationPctX100.toFixed(2)).toBe("10.00");
    // (295 − 300) / 300 × 100 = −1.666… %.
    const metr = viewAt(views, 1);
    expect(metr.dailyVariationPctX100.toFixed(2)).toBe("-1.67");
  });

  it("la variación diaria se calcula en el constructor financiero de 64 cifras (no en el Decimal base de 20)", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        [
          "PAMP",
          {
            priceArs: "1.234567890123456789012345678901234567890",
            previousCloseArs: "1.0",
          },
        ],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 1,
    });

    const variation = viewAt(views, 0).dailyVariationPctX100;
    // El Decimal base (precisión 20) redondearía a 23.456789012345678901;
    // el constructor financiero conserva las 64 cifras (división exacta por 1).
    expect(variation).toBeInstanceOf(FinancialDecimal);
    expect(variation.toFixed(20)).toBe("23.45678901234567890123");
    expect(FinancialDecimal.precision).toBe(64);
  });

  it("conserva el centavo de montos por encima de MAX_SAFE_INTEGER sin pasar por number", async () => {
    const catalog = buildCatalog([instrument(1, "PAMP", "Pampa Holding S.A.")]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        [
          "PAMP",
          {
            priceArs: "90071992547409.93",
            previousCloseArs: "90071992547409.90",
          },
        ],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 1,
    });

    const pamp = viewAt(views, 0);
    expect(pamp.priceArs.toFixed(2)).toBe("90071992547409.93");
    expect(pamp.previousCloseArs.toFixed(2)).toBe("90071992547409.90");
    // Variación desde los centavos EXACTOS (0.03 / 90071992547409.90 × 100);
    // un number habría movido el centavo y cambiado la magnitud.
    expect(pamp.dailyVariationPctX100.toString()).toMatch(/^3\.3306/);
  });

  it("candidatos iniciales sin cotización se omiten y el cupo se completa con la página siguiente (offset interno)", async () => {
    // BMA (página 1) y CRES (página 2) tienen cotización; GGAL no.
    const catalog = buildCatalog([
      instrument(1, "BMA", "Banco Macro S.A."),
      instrument(2, "GGAL", "Grupo Financiero Galicia S.A."),
      instrument(3, "CRES", "Cresud S.A.C.I.F."),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["BMA", { priceArs: "1500.00", previousCloseArs: "1480.00" }],
        ["GGAL", null],
        ["CRES", { priceArs: "1100.00", previousCloseArs: "1090.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 2,
    });

    // Página 1: 2 candidatos (restante 2) → BMA cotiza, GGAL null ⇒ se pide
    // la página 2 con restante 1 desde offset 2; CRES completa el cupo.
    expect(catalog.searchByQueryCalls).toEqual([
      ["", 2, 0],
      ["", 1, 2],
    ]);
    expect(views.map((view) => view.ticker)).toEqual(["BMA", "CRES"]);
    expect(quotes.quoteCalls).toEqual(["BMA", "GGAL", "CRES"]);
  });

  it("agotados los candidatos devuelve menos que el límite (sin fallback al seed ni reemplazos)", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "PGR", "Phoenix Global Resources"),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["PAMP", { priceArs: "1000.00", previousCloseArs: "990.00" }],
        ["PGR", null],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 10,
    });

    expect(views).toHaveLength(1);
    expect(views.map((view) => view.ticker)).toEqual(["PAMP"]);
  });

  it("catálogo vacío ⇒ [] sin consultar la fuente de cotizaciones", async () => {
    const catalog = buildCatalog([]);
    const quotes = buildQuoteSource({ quotes: new Map() });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "noexiste",
      limit: 5,
    });

    expect(views).toEqual([]);
    expect(catalog.searchByQueryCalls).toEqual([["noexiste", 5, 0]]);
    expect(quotes.quoteCalls).toEqual([]);
  });

  it("MarketDataServiceUnavailableError después de éxito parcial aborta (no listado parcial como éxito)", async () => {
    const catalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "BMA", "Banco Macro S.A."),
    ]);
    const failure = new MarketDataServiceUnavailableError();
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async (ticker) => {
        if (ticker === "PAMP") {
          return quote({ priceArs: "1000.00", previousCloseArs: "990.00" });
        }
        throw failure;
      },
    };

    await expect(
      searchInstruments(buildDeps(catalog, quotes), { query: "", limit: 2 }),
    ).rejects.toBe(failure);
  });

  it("errores inesperados de repo o fuente se propagan sin convertirse en no-cotiza", async () => {
    const catalog: InstrumentRepository = {
      findById: async () => null,
      findByIds: async () => [],
      findByTicker: async () => null,
      searchByQuery: async () => {
        throw new Error("La base de datos explotó.");
      },
    };
    const quotes = buildQuoteSource({ quotes: new Map() });

    await expect(
      searchInstruments(buildDeps(catalog, quotes), { query: "", limit: 1 }),
    ).rejects.toThrow("La base de datos explotó.");

    const brokenQuotes: InstrumentQuoteSource = {
      getCurrentQuote: async () => {
        throw new Error("Parser del proveedor roto.");
      },
    };
    const healthyCatalog = buildCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
    ]);

    await expect(
      searchInstruments(buildDeps(healthyCatalog, brokenQuotes), {
        query: "",
        limit: 1,
      }),
    ).rejects.toThrow("Parser del proveedor roto.");
  });

  it("concurrencia acotada a 1: nunca dos cotizaciones en simultáneo", async () => {
    const catalog = buildCatalog([
      instrument(1, "ALUA", "Aluar Aluminio Argentino S.A.I.C."),
      instrument(2, "BMA", "Banco Macro S.A."),
      instrument(3, "CRES", "Cresud S.A.C.I.F."),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["ALUA", { priceArs: "800.00", previousCloseArs: "790.00" }],
        ["BMA", { priceArs: "1500.00", previousCloseArs: "1480.00" }],
        ["CRES", { priceArs: "1100.00", previousCloseArs: "1090.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 3,
    });

    expect(views).toHaveLength(3);
    expect(quotes.maxConcurrentCalls()).toBe(1);
  });

  it("no consulta más candidatos que los necesarios: cupo completo en la primera página corta la iteración", async () => {
    const catalog = buildCatalog([
      instrument(1, "ALUA", "Aluar Aluminio Argentino S.A.I.C."),
      instrument(2, "BMA", "Banco Macro S.A."),
      instrument(3, "CRES", "Cresud S.A.C.I.F."),
      instrument(4, "GGAL", "Grupo Financiero Galicia S.A."),
    ]);
    const quotes = buildQuoteSource({
      quotes: new Map([
        ["ALUA", { priceArs: "800.00", previousCloseArs: "790.00" }],
        ["BMA", { priceArs: "1500.00", previousCloseArs: "1480.00" }],
      ]),
    });

    const views = await searchInstruments(buildDeps(catalog, quotes), {
      query: "",
      limit: 2,
    });

    expect(views.map((view) => view.ticker)).toEqual(["ALUA", "BMA"]);
    expect(quotes.quoteCalls).toEqual(["ALUA", "BMA"]);
    expect(catalog.searchByQueryCalls).toEqual([["", 2, 0]]);
  });
});
