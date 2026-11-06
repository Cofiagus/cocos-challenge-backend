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
const RATE_LIMITED_STATUS = 429;

/**
 * Identificación de la aplicación ante Yahoo: el proveedor rate-limita (429)
 * a clientes sin User-Agent distinguible. Se manda en cada llamada.
 */
export const YAHOO_USER_AGENT =
  "cocos-challenge-backend/1.0 (+https://github.com/Cofiagus/cocos-challenge-backend)";

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
    signal?: AbortSignal,
  ): Promise<InstrumentQuote | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Cancelación cooperativa: si el presupuesto del request vence (o el
    // llamador aborta), se corta la request en vuelo ya mismo en vez de
    // dejarla huérfana hasta agotar el timeout propio del adaptador.
    const forwardAbort = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await this.fetchChart(ticker, controller.signal);
      if (response === null) return null;
      const json = await this.readJson(response);
      const parsed = YahooChartResponseSchema.safeParse(json);
      if (!parsed.success) throw new MarketDataServiceUnavailableError();
      return this.extractQuote(parsed.data, ticker);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  };

  private readonly buildUrl = (ticker: string): string =>
    `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(`${ticker}.BA`)}?range=1d&interval=1m`;

  /**
   * Deja registro del motivo del 429 (rate limit del proveedor) antes de
   * traducirlo a indisponibilidad: sin esto, un 429 medido es indistinguible
   * de un 5xx en los logs.
   */
  private readonly reportRateLimit = (
    ticker: string,
    response: Response,
  ): void => {
    const reason =
      response.statusText.trim() === ""
        ? "Too Many Requests"
        : response.statusText.trim();
    const retryAfter = response.headers.get("retry-after") ?? "no informado";
    console.warn(
      `[yahoo] 429 ${reason} al cotizar ${ticker}.BA (rate limit del proveedor; Retry-After: ${retryAfter}).`,
    );
  };

  private readonly fetchChart = async (
    ticker: string,
    signal: AbortSignal,
  ): Promise<Response | null> => {
    try {
      const response = await this.fetchImpl(this.buildUrl(ticker), {
        signal,
        headers: {
          "User-Agent": YAHOO_USER_AGENT,
          Accept: "application/json",
        },
      });
      if (response.status === 404) return null;
      if (response.status === RATE_LIMITED_STATUS) {
        this.reportRateLimit(ticker, response);
        throw new MarketDataServiceUnavailableError();
      }
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
