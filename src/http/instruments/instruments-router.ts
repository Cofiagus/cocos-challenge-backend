// UC-2 — GET /api/instruments?query= (FASE 2 — Célula C).
//
// Router factory con DI (patrón buildApp de src/http/app.ts): deps con las
// INTERFACES de src/domain/ports. Handler sin lógica de negocio: Zod (borde)
// → searchByQuery (Célula B: ILIKE ticker O name, EXCLUYE MONEDA, ORDER BY
// ticker, LIMIT) → UN batch de snapshots de los resultados (getLatestSnapshots,
// sin N+1) → serialización del contrato.
//
// DECISIONS.md: query vacía o ausente ⇒ 400 VALIDATION_ERROR (es lectura:
// no se crea nada). MONEDA no aparece (la filtra searchByQuery). Sin
// marketdata (PGR/IRCP del seed): price/previousClose null y variación null.

import { Router } from "express";
import type { Request, Response } from "express";
import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  API_ERROR_CODES,
  InstrumentSearchQuerySchema,
  InstrumentSearchResult,
  apiErrorBody,
  serializeMoneyArs,
  serializePct,
} from "../../contracts/index.js";
import type { MarketdataSnapshot } from "../../contracts/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
} from "../../domain/ports/index.js";

/** 100, para los puntos porcentuales — Decimal, nunca float. */
const HUNDRED = new Decimal(100);

/** Deps del slice de instruments: interfaces de src/domain/ports. */
export interface InstrumentsRouterDeps {
  /** Catálogo: searchByQuery excluye MONEDA, ordena y limita. */
  readonly instruments: InstrumentRepository;
  /** Precios de referencia: UN batch de snapshots de los resultados. */
  readonly marketdata: MarketdataRepository;
}

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

/**
 * Variación diaria del snapshot (serialización del contrato, UC-2):
 * (close − previousClose) / previousClose × 100. Null si no computable
 * (previousClose 0 — no hay una función de dominio para esto: es la
 * proyección de UNA vela, no una agregación de datos de repos).
 */
const dailyVariationPctX100 = (
  snapshot: MarketdataSnapshot,
): Decimal | null =>
  snapshot.previousCloseArs.isZero()
    ? null
    : snapshot.closeArs
        .minus(snapshot.previousCloseArs)
        .div(snapshot.previousCloseArs)
        .mul(HUNDRED);

export const buildInstrumentsRouter = (
  deps: InstrumentsRouterDeps,
): Router => {
  const router = Router();

  router.get("/instruments", async (req: Request, res: Response) => {
    // Borde: Zod estricto sobre la query string, sin cast. Vacía o
    // ausente ⇒ 400 (NO crea nada: es una búsqueda de lectura).
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
    const { query, limit } = parsed.data;

    // UNA query: searchByQuery (Célula B) ya excluye MONEDA, ordena por
    // ticker y aplica el LIMIT en SQL.
    const found = await deps.instruments.searchByQuery(query, limit);

    // UN batch de snapshots de los resultados (sin N+1).
    const snapshots = await deps.marketdata.getLatestSnapshots(
      found.map((instrument) => instrument.id),
    );
    const snapshotByInstrument = new Map(
      snapshots.map(
        (snapshot): [number, MarketdataSnapshot] => [
          snapshot.instrumentId,
          snapshot,
        ],
      ),
    );

    const body: InstrumentSearchResult[] = found.map((instrument) => {
      const snapshot = snapshotByInstrument.get(instrument.id);
      const variation =
        snapshot === undefined ? null : dailyVariationPctX100(snapshot);
      return {
        ticker: instrument.ticker,
        name: instrument.name,
        type: instrument.type,
        // Sin marketdata ⇒ price/previousClose null (PGR/IRCP del seed).
        price:
          snapshot === undefined ? null : serializeMoneyArs(snapshot.closeArs),
        previousClose:
          snapshot === undefined
            ? null
            : serializeMoneyArs(snapshot.previousCloseArs),
        dailyVariationPct:
          variation === null ? null : serializePct(variation),
      };
    });

    res.status(200).json(body);
  });

  return router;
};