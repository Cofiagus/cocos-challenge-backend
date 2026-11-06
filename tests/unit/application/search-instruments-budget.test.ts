// Tests del PRESUPUESTO de cotizaciones de UC-2 (Q3=A: SIN cache).
//
// El coste del proveedor en el request de búsqueda queda acotado por (1) un
// deadline ÚNICO de request y (2) un paralelismo con tope. Antes,
// getCurrentQuote se llamaba SECUENCIALMENTE por candidato con `limit` hasta
// 100 y timeout de 5 s por llamada: peor caso ~500 s colgado para el cliente.
//
// Cubre: deadline vencido a MITAD de página (⇒ MarketDataServiceUnavailable
// Error, nunca lista parcial), fuente que falla en el PRIMER ticker, fuente
// que devuelve null para todos (cupo vacío sin error), orden del catálogo
// preservado bajo paralelismo, ausencia de estado/cache entre requests y los
// defaults de dominio.
//
// Dinero: FinancialDecimal (64 cifras) desde STRING (D1/D3).

import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../../src/contracts/index.js";
import type { InstrumentRecord } from "../../../src/contracts/index.js";
import {
  DEFAULT_QUOTE_CONCURRENCY,
  DEFAULT_QUOTE_DEADLINE_MS,
  searchInstruments,
} from "../../../src/application/instruments/search-instruments.js";
import type { SearchInstrumentsDeps } from "../../../src/application/instruments/search-instruments.js";
import type {
  InstrumentQuote,
  InstrumentQuoteSource,
  InstrumentRepository,
} from "../../../src/domain/ports/index.js";

// ---------------------------------------------------------------------------
// Insumos (sin DB, sin red)
// ---------------------------------------------------------------------------

const instrument = (id: number, ticker: string): InstrumentRecord => ({
  id,
  ticker,
  name: `${ticker} S.A.`,
  type: "ACCIONES",
});

const quoteOf = (priceArs: string, previousCloseArs: string): InstrumentQuote => ({
  priceArs: new FinancialDecimal(priceArs),
  previousCloseArs: new FinancialDecimal(previousCloseArs),
});

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

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Promesa que nunca se asienta: proveedor colgado, sin timers propios. */
const neverSettles = (): Promise<InstrumentQuote | null> =>
  new Promise<InstrumentQuote | null>(() => {});

const FOUR_TICKERS = ["ALUA", "BMA", "CRES", "GGAL"] as const;

const fourInstrumentsCatalog = (): ReturnType<typeof buildCatalog> =>
  buildCatalog(FOUR_TICKERS.map((ticker, index) => instrument(index + 1, ticker)));

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

describe("searchInstruments — presupuesto de cotizaciones del request", () => {
  it("deadline vencido a mitad de página ⇒ MarketDataServiceUnavailableError, nunca lista parcial como éxito", async () => {
    const catalog = fourInstrumentsCatalog();
    const quoteCalls: string[] = [];
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async (ticker) => {
        quoteCalls.push(ticker);
        // Los dos primeros responden (hay éxito parcial en memoria) y el
        // resto de la página cuelga: sólo el deadline del REQUEST corta, no
        // un timeout por llamada.
        if (ticker === "ALUA" || ticker === "BMA") {
          return quoteOf("100.00", "90.00");
        }
        return neverSettles();
      },
    };

    const search = searchInstruments(
      {
        instruments: catalog,
        quotes,
        quoteBudget: { deadlineMs: 40, concurrency: 2 },
      },
      { query: "", limit: 4 },
    );

    await expect(search).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
    // La página entera se llegó a intentar: el corte es de presupuesto, no de
    // una página corta del catálogo.
    expect(quoteCalls).toEqual([...FOUR_TICKERS]);
  });

  it("falla de la fuente en el PRIMER ticker ⇒ se propaga tal cual (el borde la traduce a 503)", async () => {
    const catalog = fourInstrumentsCatalog();
    const failure = new MarketDataServiceUnavailableError();
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async () => {
        throw failure;
      },
    };

    await expect(
      searchInstruments(
        {
          instruments: catalog,
          quotes,
          quoteBudget: { concurrency: 2 },
        },
        { query: "", limit: 2 },
      ),
    ).rejects.toBe(failure);
  });

  it("fuente null para TODOS ⇒ cupo vacío sin error (un listado vacío no es falla del servicio)", async () => {
    const catalog = buildCatalog([
      instrument(1, "ALUA"),
      instrument(2, "BMA"),
      instrument(3, "CRES"),
    ]);
    const quoteCalls: string[] = [];
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async (ticker) => {
        quoteCalls.push(ticker);
        return null;
      },
    };

    const views = await searchInstruments(
      { instruments: catalog, quotes },
      { query: "", limit: 3 },
    );

    expect(views).toEqual([]);
    // Cada candidato se consultó UNA vez; la página siguiente viene vacía y
    // corta la iteración (sin bucle infinito ni fallback al seed).
    expect(quoteCalls).toEqual(["ALUA", "BMA", "CRES"]);
    expect(catalog.searchByQueryCalls).toEqual([
      ["", 3, 0],
      ["", 3, 3],
    ]);
  });

  it("preserva el orden del catálogo con paralelismo: ordena por posición, no por llegada", async () => {
    const tickers = ["ALUA", "BMA", "CRES", "GGAL", "PAMP"];
    const catalog = buildCatalog(
      tickers.map((ticker, index) => instrument(index + 1, ticker)),
    );
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async (ticker) => {
        const position = tickers.indexOf(ticker);
        // El ÚLTIMO del catálogo responde PRIMERO: si el resultado se armara
        // por orden de llegada saldría invertido.
        await delay((tickers.length - position) * 4);
        return quoteOf("100.00", "90.00");
      },
    };

    const views = await searchInstruments(
      {
        instruments: catalog,
        quotes,
        // Toda la página en vuelo a la vez: máxima oportunidad de desordenar.
        quoteBudget: { concurrency: tickers.length },
      },
      { query: "", limit: tickers.length },
    );

    expect(views.map((view) => view.ticker)).toEqual(tickers);
    expect(views.map((view) => view.name)).toEqual(
      tickers.map((ticker) => `${ticker} S.A.`),
    );
  });

  it("sin cache ni estado entre requests: cada invocación tiene su deadline y vuelve a pedir los precios", async () => {
    const catalog = buildCatalog([instrument(1, "ALUA"), instrument(2, "BMA")]);
    const quoteCalls: string[] = [];
    const quotes: InstrumentQuoteSource = {
      getCurrentQuote: async (ticker) => {
        quoteCalls.push(ticker);
        await delay(10);
        return quoteOf("100.00", "90.00");
      },
    };
    const deps: SearchInstrumentsDeps = {
      instruments: catalog,
      quotes,
      quoteBudget: { deadlineMs: 500, concurrency: 2 },
    };

    const first = await searchInstruments(deps, { query: "", limit: 2 });
    const second = await searchInstruments(deps, { query: "", limit: 2 });

    expect(first.map((view) => view.ticker)).toEqual(["ALUA", "BMA"]);
    expect(second.map((view) => view.ticker)).toEqual(["ALUA", "BMA"]);
    // Sin cache: los precios se piden de nuevo en el segundo request.
    expect(quoteCalls).toEqual(["ALUA", "BMA", "ALUA", "BMA"]);
  });

  it("los defaults del dominio acotan el request: deadline > timeout de UNA llamada y concurrencia > 1", () => {
    // El deadline debe superar los 5 s del timeout por llamada del adaptador
    // Yahoo (si no, una llamada lenta pero exitosa se volvería 503) y quedar
    // muy por debajo del peor caso anterior (100 candidatos × 5 s = 500 s).
    expect(DEFAULT_QUOTE_DEADLINE_MS).toBeGreaterThan(5_000);
    expect(DEFAULT_QUOTE_DEADLINE_MS).toBeLessThan(100 * 5_000);
    // Paralelismo: más de 1 (si no, no hay mejora) y acotado (el proveedor
    // rate-limitea; el fan-out por página nunca supera `limit`).
    expect(DEFAULT_QUOTE_CONCURRENCY).toBeGreaterThan(1);
    expect(DEFAULT_QUOTE_CONCURRENCY).toBeLessThanOrEqual(10);
  });
});
