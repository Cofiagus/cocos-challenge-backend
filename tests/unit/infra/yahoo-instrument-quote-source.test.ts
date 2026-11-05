// Unit tests del adaptador Yahoo (UC-2): sin red real, con fetch fake.
// Cubren precio/cierre anterior, validaciones semánticas, 404, 429, 5xx,
// error de red, timeout real vía AbortSignal y JSON ilegible.
//
// Dinero del port: FinancialDecimal (precisión 64 del proyecto), construido
// desde strings — NO el `Decimal` base de decimal.js (D1, main). Los valores
// externos llegan como `number` tras `response.json()` (limitación afirmada
// en el plan, interpretación (a)): `FinancialDecimal(String(value))` no
// recupera dígitos perdidos por IEEE-754; se opera con 64 cifras de precisión.

import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../../src/contracts/index.js";
import { YahooInstrumentQuoteSource } from "../../../src/infra/yahoo/yahoo-instrument-quote-source.js";

const YAHOO_CHART_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/PAMP.BA?range=1d&interval=1m";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const chartBody = (metaOverrides: Record<string, unknown> = {}) => ({
  chart: {
    result: [
      {
        meta: {
          currency: "ARS",
          symbol: "PAMP.BA",
          regularMarketPrice: 123.45,
          previousClose: 120.0,
          regularMarketTime: 1_699_999_999,
          ...metaOverrides,
        },
      },
    ],
    error: null,
  },
});

const sourceWith = (
  fetchImpl: typeof fetch,
  timeoutMs = 5_000,
): YahooInstrumentQuoteSource =>
  new YahooInstrumentQuoteSource(fetchImpl, timeoutMs);

const fakeFetchReturning = (response: Response): typeof fetch =>
  jest.fn().mockResolvedValue(response) as unknown as typeof fetch;

const fakeFetchRejecting = (error: unknown): typeof fetch =>
  jest.fn().mockRejectedValue(error) as unknown as typeof fetch;

describe("YahooInstrumentQuoteSource", () => {
  it("devuelve precio y cierre anterior como FinancialDecimal construidos desde el JSON externo", async () => {
    const fetchImpl = fakeFetchReturning(jsonResponse(chartBody()));
    const source = sourceWith(fetchImpl);

    const quote = await source.getCurrentQuote("PAMP");

    expect(quote).not.toBeNull();
    expect(quote?.priceArs).toBeInstanceOf(FinancialDecimal);
    expect(quote?.priceArs.toFixed(2)).toBe("123.45");
    expect(quote?.previousCloseArs).toBeInstanceOf(FinancialDecimal);
    expect(quote?.previousCloseArs.toFixed(2)).toBe("120.00");
    expect(FinancialDecimal.precision).toBe(64);
    expect(fetchImpl).toHaveBeenCalledWith(
      YAHOO_CHART_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("devuelve null si falta meta (sin cotización)", async () => {
    const fetchImpl = fakeFetchReturning(
      jsonResponse({ chart: { result: [{}], error: null } }),
    );

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).resolves.toBeNull();
  });

  it("devuelve null si el precio no es positivo y finito", async () => {
    const fetchImpl = fakeFetchReturning(
      jsonResponse(chartBody({ regularMarketPrice: -1 })),
    );

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).resolves.toBeNull();
  });

  it("devuelve null si la moneda no es ARS", async () => {
    const fetchImpl = fakeFetchReturning(
      jsonResponse(chartBody({ currency: "USD" })),
    );

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).resolves.toBeNull();
  });

  it("devuelve null si el cierre anterior no es positivo y finito", async () => {
    const fetchImpl = fakeFetchReturning(
      jsonResponse(chartBody({ previousClose: 0 })),
    );

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).resolves.toBeNull();
  });

  it("devuelve null ante HTTP 404 (símbolo inexistente)", async () => {
    const fetchImpl = fakeFetchReturning(new Response(null, { status: 404 }));

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).resolves.toBeNull();
  });

  it("lanza MarketDataServiceUnavailableError ante HTTP 429", async () => {
    const fetchImpl = fakeFetchReturning(new Response(null, { status: 429 }));

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
  });

  it("lanza MarketDataServiceUnavailableError ante HTTP 500", async () => {
    const fetchImpl = fakeFetchReturning(new Response(null, { status: 500 }));

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
  });

  it("lanza MarketDataServiceUnavailableError ante error de red", async () => {
    const fetchImpl = fakeFetchRejecting(new TypeError("fetch failed"));

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
  });

  it("lanza MarketDataServiceUnavailableError ante JSON ilegible", async () => {
    const fetchImpl = fakeFetchReturning(
      new Response("not-json", { status: 200 }),
    );

    await expect(sourceWith(fetchImpl).getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
  });

  it("aborta por timeout real y lanza MarketDataServiceUnavailableError", async () => {
    const abortableFetch = (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("Aborted"));
        });
      });

    const source = sourceWith(abortableFetch as unknown as typeof fetch, 10);

    await expect(source.getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
  });

  it("aborta la lectura del body si el stream no cierra dentro del timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const hangingBodyFetch = (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      observedSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new Error("aborted"));
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };

    const source = sourceWith(hangingBodyFetch as unknown as typeof fetch, 25);

    const startedAt = Date.now();
    await expect(source.getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(observedSignal?.aborted).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
