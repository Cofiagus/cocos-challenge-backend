// UC-2 — GET /api/instruments?query=
//
// DECISIONS.md: MONEDA no aparece en búsqueda. Query vacía → 400. Límite
// por defecto del contrato (recorte del plan: la paginación es lo primero
// que se recorta, el límite se mantiene).

import { z } from "zod";
import { InstrumentTypeSchema } from "./enums.js";
import { MoneyArsSchema, PctSchema } from "./money.js";

export const DEFAULT_INSTRUMENT_SEARCH_LIMIT = 20;
export const MAX_INSTRUMENT_SEARCH_LIMIT = 100;

/** Query string: match parcial case-insensitive sobre ticker y/o name. */
export const InstrumentSearchQuerySchema = z.strictObject({
  /** Requerido y no vacío ("" o ausente → 400). */
  query: z.string().min(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_INSTRUMENT_SEARCH_LIMIT)
    .default(DEFAULT_INSTRUMENT_SEARCH_LIMIT),
});
export type InstrumentSearchQuery = z.infer<typeof InstrumentSearchQuerySchema>;

/** Resultado individual: último precio y variación diaria. */
export const InstrumentSearchResultSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  type: InstrumentTypeSchema,
  /** Close de la última fila de marketdata por date. Null si sin marketdata. */
  price: MoneyArsSchema.nullable(),
  previousClose: MoneyArsSchema.nullable(),
  /** (close − previousClose) / previousClose × 100, 2 decimales. Null si no computable. */
  dailyVariationPct: PctSchema.nullable(),
});
export type InstrumentSearchResult = z.infer<
  typeof InstrumentSearchResultSchema
>;

/** Respuesta: listado de activos (sin MONEDA). */
export const InstrumentSearchResponseSchema = z.array(
  InstrumentSearchResultSchema,
);
export type InstrumentSearchResponse = z.infer<
  typeof InstrumentSearchResponseSchema
>;
