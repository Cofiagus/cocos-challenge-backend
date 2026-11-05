// UC-2 — GET /api/instruments?query=.
//
// Router factory con DI (patrón buildApp de src/http/app.ts): deps = los
// ports que consume el caso de uso searchInstruments. Handler sin lógica de
// negocio: Zod (borde) → searchInstruments (filtro, cupo y cotización
// actual) → serialización del contrato.
//
// Spec instruments-current-quotes Rev. 2: query ausente, vacía o sólo
// espacios ⇒ listado inicial; limit default 10 (entero 1..100); ticker sin
// cotización se omite y el cupo se completa con los siguientes candidatos;
// MarketDataServiceUnavailableError ⇒ 503 MARKET_DATA_SERVICE_UNAVAILABLE
// (ni seed fallback ni listado parcial como éxito); cualquier otro error se
// propaga al error handler (500 INTERNAL_ERROR genérico).
//
// Dinero de salida (D3): price/previousClose son STRING monetario de 2
// decimales (serializeMoneyArs desde FinancialDecimal, nunca number);
// dailyVariationPct sigue siendo number (serializePct, 2 decimales).

import { Router } from "express";
import type { Request, Response } from "express";
import {
  API_ERROR_CODES,
  InstrumentSearchQuerySchema,
  MarketDataServiceUnavailableError,
  apiErrorBody,
  serializeMoneyArs,
  serializePct,
} from "../../contracts/index.js";
import type { InstrumentSearchResult } from "../../contracts/index.js";
import { searchInstruments } from "../../application/instruments/search-instruments.js";
import type { InstrumentSearchView } from "../../application/instruments/search-instruments.js";
import { validationMessage } from "../shared/edge.js";
import type {
  InstrumentQuoteSource,
  InstrumentRepository,
} from "../../domain/ports/index.js";

/**
 * Deps del slice de instruments: los puertos que consume el caso de uso
 * searchInstruments. Sin `quotes` no hay búsqueda que valga (los precios SON
 * la respuesta desde Rev. 2), así que el tipo lo exige: el composition root
 * que omita la fuente no compila.
 */
export interface InstrumentsRouterDeps {
  /** Catálogo: searchByQuery excluye MONEDA, ordena y limita. */
  readonly instruments: InstrumentRepository;
  /** Cotización ACTUAL por ticker (Yahoo en producción). */
  readonly quotes: InstrumentQuoteSource;
}

/** Vista del caso de uso → resultado del contrato (money string 2dp, pct number). */
const toSearchResult = (
  view: InstrumentSearchView,
): InstrumentSearchResult => ({
  ticker: view.ticker,
  name: view.name,
  type: view.type,
  price: serializeMoneyArs(view.priceArs),
  previousClose: serializeMoneyArs(view.previousCloseArs),
  dailyVariationPct: serializePct(view.dailyVariationPctX100),
});

export const buildInstrumentsRouter = (
  deps: InstrumentsRouterDeps,
): Router => {
  const router = Router();

  router.get("/instruments", async (req: Request, res: Response) => {
    // Borde: Zod estricto sobre la query string, sin cast. Es lectura: nada
    // se escribe; limit fuera de 1..100 o campo desconocido ⇒ 400.
    const parsed = InstrumentSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        apiErrorBody(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Query inválida: ${validationMessage(parsed.error)}`,
        ),
      );
      return;
    }

    try {
      const views = await searchInstruments(
        { instruments: deps.instruments, quotes: deps.quotes },
        parsed.data,
      );
      res.status(200).json(views.map(toSearchResult));
    } catch (error) {
      if (!(error instanceof MarketDataServiceUnavailableError)) throw error;
      // Proveedor indisponible: 503 explícito, sin precios viejos ni un
      // vacío que disimule la falla (spec Rev. 2, decisión aprobada 2).
      res
        .status(503)
        .json(
          apiErrorBody(
            API_ERROR_CODES.MARKET_DATA_SERVICE_UNAVAILABLE,
            error.message,
          ),
        );
    }
  });

  return router;
};
