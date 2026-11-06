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
//  - Presupuesto de tiempo ÚNICO para todo el request (QuoteBudget.deadlineMs,
//    default DEFAULT_QUOTE_DEADLINE_MS): al vencer se rechaza con
//    MarketDataServiceUnavailableError (fallo de la fuente ⇒ 503), nunca con
//    una lista parcial como éxito. Antes no había deadline de request y el
//    peor caso era 100 candidatos × 5 s de timeout = ~500 s colgando al
//    cliente.
//  - Paralelismo ACOTADO por página (QuoteBudget.concurrency, default
//    DEFAULT_QUOTE_CONCURRENCY): cada página pide exactamente el cupo
//    restante, así que el fan-out al proveedor nunca supera el límite de la
//    página ni el `limit` del contrato (máx. 100).
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
}

/**
 * Deadline total del request. Debe superar el timeout de UNA llamada del
 * proveedor (5 s en YahooInstrumentQuoteSource) para no convertir una llamada
 * lenta pero exitosa en 503, y queda muy por debajo del peor caso anterior
 * (100 candidatos × 5 s ≈ 500 s).
 */
export const DEFAULT_QUOTE_DEADLINE_MS = 8_000;

/**
 * Cotizaciones en vuelo por request. Acota el fan-out hacia un proveedor que
 * rate-limita sin volver a la latencia secuencial: una página de 10 tarda
 * ceil(10 / 4) rondas en vez de 10.
 */
export const DEFAULT_QUOTE_CONCURRENCY = 4;

/** Presupuesto efectivo: defaults del dominio, con override de los tests. */
const resolveBudget = (override?: Partial<QuoteBudget>): QuoteBudget => {
  const concurrency = Math.trunc(
    override?.concurrency ?? DEFAULT_QUOTE_CONCURRENCY,
  );
  return {
    deadlineMs: override?.deadlineMs ?? DEFAULT_QUOTE_DEADLINE_MS,
    // Piso 1: una concurrencia 0 o negativa dejaría el request sin cotizar.
    concurrency: Math.max(1, concurrency),
  };
};

/** Puertos que el caso de uso consume (interfaces, nunca implementaciones). */
export interface SearchInstrumentsDeps {
  /** Catálogo: filtro, exclusión de MONEDA y orden ticker asc (searchByQuery). */
  readonly instruments: InstrumentRepository;
  /** Cotización ACTUAL por ticker (null = sin cotización computable). */
  readonly quotes: InstrumentQuoteSource;
  /** Override del presupuesto (deadline/concurrencia); tests. Default: dominio. */
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
 * Corre `work` con un deadline único de request: si vence, rechaza con
 * MarketDataServiceUnavailableError (fallo de la fuente ⇒ el borde lo
 * traduce a 503), nunca con una lista parcial como éxito. El timer se libera
 * siempre para no dejar handles abiertos.
 */
const withDeadline = async <T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new MarketDataServiceUnavailableError()),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Cotiza UNA página del catálogo con paralelismo acotado. Las cotizaciones
 * `null` se omiten (política de faltantes) y cualquier error se propaga. Un
 * trabajador que arranca después del deadline falla con el error de la fuente
 * en vez de seguir pegándole al proveedor.
 */
const quotePage = async (
  candidates: readonly InstrumentRecord[],
  quotes: InstrumentQuoteSource,
  deadlineAt: number,
  concurrency: number,
): Promise<readonly InstrumentSearchView[]> => {
  const pageQuotes = await mapWithConcurrency(
    candidates,
    concurrency,
    async (candidate) => {
      if (Date.now() >= deadlineAt) {
        throw new MarketDataServiceUnavailableError();
      }
      return quotes.getCurrentQuote(candidate.ticker);
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

/**
 * Itera por offset interno (páginas del tamaño del cupo RESTANTE) hasta
 * llenar el límite o agotar los candidatos del filtro.
 */
const collectViews = async (
  deps: SearchInstrumentsDeps,
  input: SearchInstrumentsInput,
  budget: QuoteBudget,
  deadlineAt: number,
): Promise<readonly InstrumentSearchView[]> => {
  const views: InstrumentSearchView[] = [];
  let offset = 0;

  while (views.length < input.limit) {
    const remaining = input.limit - views.length;
    const candidates = await deps.instruments.searchByQuery(
      input.query,
      remaining,
      offset,
    );
    const pageViews = await quotePage(
      candidates,
      deps.quotes,
      deadlineAt,
      budget.concurrency,
    );
    views.push(...pageViews);

    if (candidates.length < remaining) {
      // Candidatos agotados: pueden quedar menos resultados que el límite.
      break;
    }
    offset += candidates.length;
  }

  return views;
};

/**
 * Busca candidatos en el catálogo y los completa con la cotización actual, con
 * un deadline ÚNICO para todo el request y paralelismo acotado. Sin cache ni
 * estado entre invocaciones: cada request paga (y acota) su propio coste.
 */
export const searchInstruments = async (
  deps: SearchInstrumentsDeps,
  input: SearchInstrumentsInput,
): Promise<readonly InstrumentSearchView[]> => {
  const budget = resolveBudget(deps.quoteBudget);
  const deadlineAt = Date.now() + budget.deadlineMs;
  return withDeadline(
    collectViews(deps, input, budget, deadlineAt),
    budget.deadlineMs,
  );
};
