// UC-2 — GET /api/instruments?query=
//
// Spec instruments-current-quotes Rev. 2: query ausente, vacía o sólo
// espacios ⇒ listado inicial ("" tras trim); con texto ⇒ match parcial
// case-insensitive por ticker/name. Límite por defecto 10 (entero 1..100).
// MONEDA no aparece en búsqueda (DECISIONS.md).
//
// Dinero de salida (D3, money.ts): `price` y `previousClose` son el string
// monetario de exactamente 2 decimales (`MoneyArsSchema`), nunca number;
// `dailyVariationPct` sigue siendo number (puntos porcentuales, 2 decimales).

import { z } from "zod";
import { InstrumentTypeSchema } from "./enums.js";
import { MoneyArsSchema, PctSchema } from "./money.js";

export const DEFAULT_INSTRUMENT_SEARCH_LIMIT = 10;
export const MAX_INSTRUMENT_SEARCH_LIMIT = 100;

/** Query string del borde: listado inicial si no hay texto de búsqueda. */
export const InstrumentSearchQuerySchema = z.strictObject({
  /** Ausente, vacía o sólo espacios ⇒ "" (listado inicial); con texto se recorta. */
  query: z
    .string()
    .optional()
    .transform((query) => (query ?? "").trim()),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_INSTRUMENT_SEARCH_LIMIT)
    .default(DEFAULT_INSTRUMENT_SEARCH_LIMIT),
});
export type InstrumentSearchQuery = z.infer<typeof InstrumentSearchQuerySchema>;

/** Resultado individual: cotización actual válida (sin precio, se omite). */
export const InstrumentSearchResultSchema = z.strictObject({
  ticker: z.string(),
  name: z.string(),
  type: InstrumentTypeSchema,
  /** Último precio de sesión vigente (fuente Yahoo); positivo y en ARS. */
  price: MoneyArsSchema,
  /** Cierre de la sesión anterior, positivo y en ARS. */
  previousClose: MoneyArsSchema,
  /** (price − previousClose) / previousClose × 100, 2 decimales. */
  dailyVariationPct: PctSchema,
});
export type InstrumentSearchResult = z.infer<
  typeof InstrumentSearchResultSchema
>;

/** Respuesta: listado de activos (sin MONEDA) con cotización actual. */
export const InstrumentSearchResponseSchema = z.array(
  InstrumentSearchResultSchema,
);
export type InstrumentSearchResponse = z.infer<
  typeof InstrumentSearchResponseSchema
>;
