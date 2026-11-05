// Adaptador Yahoo Finance del puerto InstrumentQuoteSource (UC-2).
// Símbolo directo ticker + ".BA", chart 1d/1m. Valida la forma externa con
// Zod antes de usar datos y traduce fallas de transporte a
// MarketDataServiceUnavailableError; un ticker sin cotización computable
// devuelve null (política aprobada de faltantes).
//
// Dinero SIEMPRE `FinancialDecimal` (64 cifras del proyecto, contracts) —
// nunca el `Decimal` base de decimal.js ni aritmética en `number`. Los
// valores llegan como `number` tras `response.json()`; se reconstruyen con
// `FinancialDecimal(String(value))` y se validan finito/positivo antes de
// entregar la quote (interpretación (a) del plan: el texto externo ya perdió
// cifras al parsear como IEEE-754 — limitación afirmada, no un parser raw).

import { z } from "zod";
import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../contracts/index.js";
import type {
  InstrumentQuote,
  InstrumentQuoteSource,
} from "../../domain/ports/index.js";

const YAHOO_CHART_BASE_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart";
const DEFAULT_TIMEOUT_MS = 5_000;
const YAHOO_SYMBOL_NOT_FOUND_CODE = "Not Found";

const YahooChartMetaSchema = z.object({
  currency: z.string().optional(),
  symbol: z.string().optional(),
  regularMarketPrice: z.number().nullable().optional(),
  previousClose: z.number().nullable().optional(),
  regularMarketTime: z.number().nullable().optional(),
});

const YahooChartResultSchema = z.object({
  meta: YahooChartMetaSchema.optional(),
});

const YahooChartErrorSchema = z.object({
  code: z.string(),
  description: z.string().optional(),
});

const YahooChartResponseSchema = z.object({
  chart: z.object({
    result: z.array(YahooChartResultSchema).nullable(),
    error: YahooChartErrorSchema.nullable().optional(),
  }),
});

type YahooChartMeta = z.infer<typeof YahooChartMetaSchema>;
type YahooChartResponse = z.infer<typeof YahooChartResponseSchema>;

const toPositiveFinancialDecimal = (
  value: number | null | undefined,
): FinancialDecimal | null => {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return new FinancialDecimal(String(value));
};

const quoteFromMeta = (
  meta: YahooChartMeta | undefined,
  expectedSymbol: string,
): InstrumentQuote | null => {
  if (meta === undefined) return null;
  if (meta.currency !== "ARS") return null;
  if (meta.symbol !== expectedSymbol) return null;
  const priceArs = toPositiveFinancialDecimal(meta.regularMarketPrice);
  const previousCloseArs = toPositiveFinancialDecimal(meta.previousClose);
  if (priceArs === null || previousCloseArs === null) return null;
  return { priceArs, previousCloseArs };
};

const isSymbolNotFound = (error: { code: string }): boolean =>
  error.code === YAHOO_SYMBOL_NOT_FOUND_CODE;

export class YahooInstrumentQuoteSource implements InstrumentQuoteSource {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  readonly getCurrentQuote = async (
    ticker: string,
  ): Promise<InstrumentQuote | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchChart(ticker, controller.signal);
      if (response === null) return null;
      const json = await this.readJson(response);
      const parsed = YahooChartResponseSchema.safeParse(json);
      if (!parsed.success) throw new MarketDataServiceUnavailableError();
      return this.extractQuote(parsed.data, ticker);
    } finally {
      clearTimeout(timer);
    }
  };

  private readonly buildUrl = (ticker: string): string =>
    `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(`${ticker}.BA`)}?range=1d&interval=1m`;

  private readonly fetchChart = async (
    ticker: string,
    signal: AbortSignal,
  ): Promise<Response | null> => {
    try {
      const response = await this.fetchImpl(this.buildUrl(ticker), { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new MarketDataServiceUnavailableError();
      return response;
    } catch (error) {
      if (error instanceof MarketDataServiceUnavailableError) throw error;
      throw new MarketDataServiceUnavailableError();
    }
  };

  private readonly readJson = async (response: Response): Promise<unknown> => {
    try {
      return await response.json();
    } catch {
      throw new MarketDataServiceUnavailableError();
    }
  };

  private readonly extractQuote = (
    payload: YahooChartResponse,
    ticker: string,
  ): InstrumentQuote | null => {
    const { chart } = payload;
    if (chart.error !== null && chart.error !== undefined) {
      if (isSymbolNotFound(chart.error)) return null;
      throw new MarketDataServiceUnavailableError();
    }
    const result = chart.result?.[0];
    if (result === undefined) return null;
    return quoteFromMeta(result.meta, `${ticker}.BA`);
  };
}
