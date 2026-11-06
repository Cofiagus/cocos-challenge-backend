// Caso de uso de búsqueda de instrumentos con cotizaciones actuales (UC-2).
//
// Orquesta el catálogo (InstrumentRepository.searchByQuery) y la fuente de
// cotizaciones actual inyectable (InstrumentQuoteSource — DECISIONS/spec
// instruments-current-quotes Rev. 2): el filtro vive en el repositorio
// (case-insensitive, excluye MONEDA, orden ticker asc) y este caso de uso
// sólo itera internamente por offset hasta completar el cupo con
// instrumentos CON cotización. No hay Express ni serialización acá: el
// borde HTTP traduce este resultado al contrato.
//
// Política aprobada (spec Rev. 2):
//  - ticker sin cotización computable (quote null): se OMITE y el cupo se
//    completa con los siguientes candidatos — sin fallback al seed ni
//    reemplazos; pueden quedar menos resultados que el límite. Un listado
//    vacío NO es un error.
//  - MarketDataServiceUnavailableError de la fuente: se PROPAGA tal cual —
//    no se disfraza de "sin cotización" ni se devuelve un listado parcial
//    como éxito (el borde lo traduce a 503).
//  - Cualquier otro error del repo o de la fuente: se propaga — un fallo
//    inesperado nunca se convierte silenciosamente en no-cotiza.
//
// Coste acotado (Q3=A: SIN cache — el precio es SIEMPRE fresco y no hay
// estado en memoria entre requests):
//  - Presupuesto de tiempo ÚNICO para todo el request (QuoteBudget.deadlineMs):
//    al vencer se ABORTA el trabajo en vuelo (AbortSignal cooperativo hacia la
//    fuente) y se rechaza con MarketDataServiceUnavailableError (fallo de la
//    fuente ⇒ 503), nunca con una lista parcial como éxito. Sin signal, las
//    llamadas en vuelo quedaban huérfanas hasta su timeout de 5 s.
//  - El deadline ESCALA con el cupo (quoteDeadlineMsFor): un deadline fijo de
//    8 s con limit=100 y concurrencia 4 daba 25 rondas y ~320 ms por llamada de
//    margen, suficiente para 503 espurios. El override inyectado manda.
//  - Paralelismo ACOTADO por página (QuoteBudget.concurrency, default
//    DEFAULT_QUOTE_CONCURRENCY): cada página pide a lo sumo el cupo restante,
//    así que el fan-out al proveedor nunca supera el límite de la página ni el
//    `limit` del contrato (máx. 100).
//  - TOPE de candidatos explorados (QuoteBudget.maxCandidates): rellenar el
//    cupo no recorre el catálogo completo cuando muchos tickers no cotizan;
//    se devuelven menos resultados (el contrato lo permite).
//  - El resultado se arma por POSICIÓN del catálogo, no por orden de llegada:
//    el orden ticker asc que garantiza el repositorio se preserva.
//  - Sin estado compartido entre requests: el presupuesto vive en la
//    invocación, nunca en un módulo.
//
// Dinero SIEMPRE FinancialDecimal (64 cifras) desde string (AGENTS.md §5.1,
// D1/D3): la fuente ya entrega FinancialDecimal; la variación se calcula en
// ese constructor y la serialización queda al borde HTTP
// (serializeMoneyArs/serializePct). Nunca el Decimal base ni un number.

import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../contracts/index.js";
import type { InstrumentRecord } from "../../contracts/index.js";
import type {
  InstrumentQuote,
  InstrumentQuoteSource,
  InstrumentRepository,
} from "../../domain/ports/index.js";

/**
 * Presupuesto de cotizaciones de UN request de búsqueda. Inyectable por deps
 * para que los tests fijen deadline y concurrencia sin tocar la producción.
 */
export interface QuoteBudget {
  /** Tiempo máximo (ms) para resolver TODAS las cotizaciones del request. */
  readonly deadlineMs: number;
  /** Máximo de cotizaciones en vuelo simultáneamente. */
  readonly concurrency: number;
  /** Tope de candidatos explorados para rellenar el cupo. */
  readonly maxCandidates: number;
}

/**
 * Deadline base del request. Cubre el cupo por defecto (10 con concurrencia 4
 * = 3 rondas) y debe superar el timeout de UNA llamada del proveedor (5 s en
 * YahooInstrumentQuoteSource) para no convertir una llamada lenta pero
 * exitosa en 503.
 */
export const DEFAULT_QUOTE_DEADLINE_MS = 8_000;

/**
 * Margen de reloj por RONDA de cotizaciones (una ronda = `concurrency`
 * llamadas en paralelo). El deadline escala con el cupo: con limit=100 y
 * concurrencia 4 hay 25 rondas, y un deadline fijo de 8 s dejaba ~320 ms por
 * llamada antes de un 503 espurio.
 */
export const QUOTE_CALL_ALLOWANCE_MS = 800;

/** Techo absoluto del deadline: un request nunca queda colgado más que esto. */
export const MAX_QUOTE_DEADLINE_MS = 30_000;

/**
 * Cotizaciones en vuelo por request. Acota el fan-out hacia un proveedor que
 * rate-limita sin volver a la latencia secuencial: una página de 10 tarda
 * ceil(10 / 4) rondas en vez de 10.
 */
export const DEFAULT_QUOTE_CONCURRENCY = 4;

/**
 * Tope de candidatos explorados por request, como múltiplo del cupo pedido:
 * evita recorrer el catálogo completo cuando muchos tickers no cotizan. El
 * contrato permite devolver menos resultados que el límite, así que el tope
 * nunca es un error.
 */
export const CANDIDATE_SCAN_FACTOR = 4;

/** Piso del tope: con límites chicos igual se exploran varios candidatos. */
export const MIN_CANDIDATE_SCAN = 20;

/**
 * Deadline efectivo del request: base de dominio, escalado por rondas del
 * cupo y acotado por MAX_QUOTE_DEADLINE_MS. Un override inyectado lo
 * reemplaza por completo.
 */
export const quoteDeadlineMsFor = (
  limit: number,
  concurrency: number = DEFAULT_QUOTE_CONCURRENCY,
): number => {
  const inFlight = Math.max(1, Math.trunc(concurrency));
  const rounds = Math.ceil(Math.max(0, limit) / inFlight);
  return Math.min(
    MAX_QUOTE_DEADLINE_MS,
    Math.max(DEFAULT_QUOTE_DEADLINE_MS, rounds * QUOTE_CALL_ALLOWANCE_MS),
  );
};

/** Presupuesto efectivo: defaults del dominio, con override de los tests. */
const resolveBudget = (
  override: Partial<QuoteBudget> | undefined,
  limit: number,
): QuoteBudget => {
  const concurrency = Math.max(
    1,
    Math.trunc(override?.concurrency ?? DEFAULT_QUOTE_CONCURRENCY),
  );
  return {
    deadlineMs: override?.deadlineMs ?? quoteDeadlineMsFor(limit, concurrency),
    // Piso 1: una concurrencia 0 o negativa dejaría el request sin cotizar.
    concurrency,
    maxCandidates: Math.max(
      1,
      Math.trunc(
        override?.maxCandidates ??
          Math.max(limit * CANDIDATE_SCAN_FACTOR, MIN_CANDIDATE_SCAN),
      ),
    ),
  };
};

/**
 * El port de cotizaciones con cancelación cooperativa opcional: la aplicación
 * propaga el AbortSignal del deadline y las fuentes que lo aceptan (Yahoo)
 * abortan la request en vuelo en vez de dejarla huérfana. Un
 * `InstrumentQuoteSource` de una sola firma sigue siendo asignable.
 */
export interface CancellableQuoteSource extends InstrumentQuoteSource {
  readonly getCurrentQuote: (
    ticker: string,
    signal?: AbortSignal,
  ) => Promise<InstrumentQuote | null>;
}

/** Puertos que el caso de uso consume (interfaces, nunca implementaciones). */
export interface SearchInstrumentsDeps {
  /** Catálogo: filtro, exclusión de MONEDA y orden ticker asc (searchByQuery). */
  readonly instruments: InstrumentRepository;
  /** Cotización ACTUAL por ticker (null = sin cotización computable). */
  readonly quotes: CancellableQuoteSource;
  /** Override del presupuesto (deadline/concurrencia/candidatos); tests. */
  readonly quoteBudget?: Partial<QuoteBudget>;
}

/** Instrumento con su cotización actual, en dinero todavía Decimal. */
export interface InstrumentSearchView {
  readonly ticker: string;
  readonly name: string;
  readonly type: InstrumentRecord["type"];
  /** Último precio de sesión disponible en la fuente. */
  readonly priceArs: FinancialDecimal;
  /** Cierre de la sesión anterior. */
  readonly previousCloseArs: FinancialDecimal;
  /** (price − previousClose) / previousClose × 100, calculado en Decimal. */
  readonly dailyVariationPctX100: FinancialDecimal;
}

export interface SearchInstrumentsInput {
  /** Ya validado por el borde; vacío ⇒ listado inicial del catálogo. */
  readonly query: string;
  /** Ya validado por el borde (entero 1..100). */
  readonly limit: number;
}

/** 100 puntos porcentuales en el constructor financiero (64 cifras). */
const HUNDRED = new FinancialDecimal("100");

/**
 * Variación diaria en FinancialDecimal: (price − prevClose) / prevClose × 100.
 * La fuente garantiza precios válidos (contrato del port), así que
 * previousClose = 0 no se normaliza acá: sería corrupción de la fuente.
 */
const dailyVariationPct = (
  priceArs: FinancialDecimal,
  previousCloseArs: FinancialDecimal,
): FinancialDecimal =>
  priceArs.minus(previousCloseArs).div(previousCloseArs).times(HUNDRED);

/** Fila del catálogo + cotización válida ⇒ vista del contrato (aún Decimal). */
const toView = (
  candidate: InstrumentRecord,
  currentQuote: InstrumentQuote,
): InstrumentSearchView => ({
  ticker: candidate.ticker,
  name: candidate.name,
  type: candidate.type,
  priceArs: currentQuote.priceArs,
  previousCloseArs: currentQuote.previousCloseArs,
  dailyVariationPctX100: dailyVariationPct(
    currentQuote.priceArs,
    currentQuote.previousCloseArs,
  ),
});

/**
 * Aplica `task` a cada item con a lo sumo `concurrency` en vuelo y devuelve
 * los resultados en el ORDEN DE ENTRADA (se indexa por posición, no por orden
 * de llegada). Ante el primer rechazo deja de arrancar trabajo nuevo y
 * propaga ese error: no se sigue consultando al proveedor después de una
 * falla.
 */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<readonly R[]> => {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await task(item);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
};

/**
 * Corre `work` con un deadline único de request: si vence, aborta el signal
 * (la fuente cancela lo que tenga en vuelo) y rechaza con
 * MarketDataServiceUnavailableError (el borde lo traduce a 503), nunca con una
 * lista parcial como éxito. El timer se libera siempre y el rechazo tardío del
 * trabajo abandonado se consume: sin unhandled rejections ni handles abiertos.
 */
const withDeadline = async <T>(
  work: Promise<T>,
  deadlineMs: number,
  abortInFlight: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abortInFlight();
      reject(new MarketDataServiceUnavailableError());
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    void work.catch(() => undefined);
  }
};

/** Contexto de una página de cotizaciones (deadline, tope y cancelación). */
interface QuotePageContext {
  readonly quotes: CancellableQuoteSource;
  readonly deadlineAt: number;
  readonly concurrency: number;
  readonly signal: AbortSignal;
}

/**
 * Cotiza UNA página del catálogo con paralelismo acotado. Las cotizaciones
 * `null` se omiten (política de faltantes) y cualquier error se propaga. Un
 * trabajador que arranca después del deadline —o con el request ya abortado—
 * falla con el error de la fuente en vez de seguir pegándole al proveedor.
 */
const quotePage = async (
  candidates: readonly InstrumentRecord[],
  context: QuotePageContext,
): Promise<readonly InstrumentSearchView[]> => {
  const pageQuotes = await mapWithConcurrency(
    candidates,
    context.concurrency,
    async (candidate) => {
      if (context.signal.aborted || Date.now() >= context.deadlineAt) {
        throw new MarketDataServiceUnavailableError();
      }
      return context.quotes.getCurrentQuote(candidate.ticker, context.signal);
    },
  );

  const views: InstrumentSearchView[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const currentQuote = pageQuotes[index] ?? null;
    // Sin cotización computable: se omite y el cupo se completa con los
    // siguientes candidatos (sin fallback al seed).
    if (currentQuote === null) continue;
    views.push(toView(candidate, currentQuote));
  }
  return views;
};

/** Presupuesto ya resuelto + deadline absoluto + signal de cancelación. */
interface RequestBudget {
  readonly budget: QuoteBudget;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/**
 * Itera por offset interno (páginas del cupo RESTANTE, recortadas por el tope
 * de candidatos) hasta llenar el límite o agotar candidatos o tope.
 */
const collectViews = async (
  deps: SearchInstrumentsDeps,
  input: SearchInstrumentsInput,
  request: RequestBudget,
): Promise<readonly InstrumentSearchView[]> => {
  const { budget, deadlineAt, signal } = request;
  const views: InstrumentSearchView[] = [];
  let offset = 0;
  let scanned = 0;

  while (views.length < input.limit && scanned < budget.maxCandidates) {
    if (signal.aborted) throw new MarketDataServiceUnavailableError();
    const remaining = input.limit - views.length;
    const pageSize = Math.min(remaining, budget.maxCandidates - scanned);
    const candidates = await deps.instruments.searchByQuery(
      input.query,
      pageSize,
      offset,
    );
    scanned += candidates.length;
    const pageViews = await quotePage(candidates, {
      quotes: deps.quotes,
      deadlineAt,
      concurrency: budget.concurrency,
      signal,
    });
    views.push(...pageViews);

    if (candidates.length < pageSize) {
      // Candidatos agotados: pueden quedar menos resultados que el límite.
      break;
    }
    offset += candidates.length;
  }

  return views;
};

/**
 * Busca candidatos en el catálogo y los completa con la cotización actual, con
 * un deadline ÚNICO para todo el request (escalado por cupo y cancelable) y
 * paralelismo acotado. Sin cache ni estado entre invocaciones: cada request
 * paga (y acota) su propio coste.
 */
export const searchInstruments = async (
  deps: SearchInstrumentsDeps,
  input: SearchInstrumentsInput,
): Promise<readonly InstrumentSearchView[]> => {
  const budget = resolveBudget(deps.quoteBudget, input.limit);
  const deadlineAt = Date.now() + budget.deadlineMs;
  const controller = new AbortController();
  return withDeadline(
    collectViews(deps, input, {
      budget,
      deadlineAt,
      signal: controller.signal,
    }),
    budget.deadlineMs,
    () => controller.abort(),
  );
};
