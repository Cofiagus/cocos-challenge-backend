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
//    reemplazos; pueden quedar menos resultados que el límite.
//  - MarketDataServiceUnavailableError de la fuente: se PROPAGA tal cual —
//    no se disfraza de "sin cotización" ni se devuelve un listado parcial
//    como éxito (el borde lo traduce a 503).
//  - Cualquier otro error del repo o de la fuente: se propaga — un fallo
//    inesperado nunca se convierte silenciosamente en no-cotiza.
//
// Concurrencia acotada: la consulta de cotizaciones es SECUENCIAL
// (concurrency 1) — cumple "no consultar todo el catálogo si no hace
// falta" y "timeout y concurrencia acotados" sin sobreconsultar al
// proveedor: cada página pide exactamente el cupo restante.
//
// Dinero SIEMPRE FinancialDecimal (64 cifras) desde string (AGENTS.md §5.1,
// D1/D3): la fuente ya entrega FinancialDecimal; la variación se calcula en
// ese constructor y la serialización queda al borde HTTP
// (serializeMoneyArs/serializePct). Nunca el Decimal base ni un number.

import { FinancialDecimal } from "../../contracts/index.js";
import type { InstrumentRecord } from "../../contracts/index.js";
import type {
  InstrumentQuoteSource,
  InstrumentRepository,
} from "../../domain/ports/index.js";

/** Puertos que el caso de uso consume (interfaces, nunca implementaciones). */
export interface SearchInstrumentsDeps {
  /** Catálogo: filtro, exclusión de MONEDA y orden ticker asc (searchByQuery). */
  readonly instruments: InstrumentRepository;
  /** Cotización ACTUAL por ticker (null = sin cotización computable). */
  readonly quotes: InstrumentQuoteSource;
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

/**
 * Busca candidatos en el catálogo y los completa con la cotización actual.
 * Itera por offset interno (páginas del tamaño del cupo RESTANTE) hasta
 * llenar el límite o agotar los candidatos del filtro.
 */
export const searchInstruments = async (
  deps: SearchInstrumentsDeps,
  input: SearchInstrumentsInput,
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

    for (const candidate of candidates) {
      // Secuencial (concurrencia acotada a 1): cada llamada espera a la
      // anterior y una página corta la iteración (no se consulta de más).
      const currentQuote = await deps.quotes.getCurrentQuote(candidate.ticker);
      if (currentQuote === null) {
        // Sin cotización computable: se omite y el cupo se completa con
        // los siguientes candidatos (sin fallback al seed).
        continue;
      }
      views.push({
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
      if (views.length === input.limit) break;
    }

    if (candidates.length < remaining) {
      // Candidatos agotados: pueden quedar menos resultados que el límite.
      break;
    }
    offset += candidates.length;
  }

  return views;
};
