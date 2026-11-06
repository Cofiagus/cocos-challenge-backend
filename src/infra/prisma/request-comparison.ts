// Comparación PURA de una orden ya reclamada contra el REQUEST entrante
// (F2-IDEM / T11.a). Vive acá —y no en order-repository.ts— para poder
// ejercitarla SIN base de datos con filas construidas a mano: era la deuda
// que obligaba a insertar filas no conformes (LIMIT sin price, cash con
// precio o instrumento cambiados) para caracterizar el CONFLICT.
//
// Semántica (idéntica a la del repositorio desde F2-IDEM):
//  - Identidad: instrumentId/side/type/timeInForce/price. El `size` NO es
//    identidad: en cash depende del monto y en trading del floor.
//  - Huella del request: con huella en AMBOS lados la huella MANDA (el monto
//    original viaja ahí, no en el `size` derivado por floor). Si falta en
//    cualquiera de los dos (fila legacy o draft sin huella) se cae a la
//    comparación histórica por `size`: comportamiento conservador vigente.
//
// El tipo de fila es ESTRUCTURAL y PROPIO (no el generado por Prisma): los
// precios/cantidades llegan como texto decimal canónico, así el módulo no
// depende de `@prisma/client` ni de una conexión.

import { FinancialDecimal } from "../../contracts/index.js";

/** Vista estructural de la fila `orders` que participa de la comparación. */
export interface OrderRequestRow {
  readonly instrumentId: number | null;
  readonly side: string;
  readonly type: string;
  readonly timeInForce: string;
  /** Decimal (24,2) como texto; null = sin precio de límite. */
  readonly price: string | null;
  /** Decimal (24,2) como texto: acciones (trading) o monto ARS (cash). */
  readonly size: string | null;
  readonly requestFingerprint: string | null;
}

/** Vista estructural del REQUEST ya normalizado por el repositorio. */
export interface RequestPayload {
  readonly instrumentId: number | null;
  readonly side: string;
  readonly type: string;
  readonly timeInForce: string;
  readonly price: string | null;
  readonly size: string;
  readonly requestFingerprint: string | null;
}

/** Veredicto del claim para una orden de TRADING con la key ya reclamada. */
export type TradingRequestOutcome = "IDEMPOTENT_REPLAY" | "IDEMPOTENT_CONFLICT";

/** Igualdad monetaria por VALOR (Decimal, nunca float): "930" == "930.00". */
const sameDecimal = (left: string | null, right: string | null): boolean => {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return new FinancialDecimal(left).equals(new FinancialDecimal(right));
};

/**
 * Mismo PAYLOAD idempotente (DECISIONS.md): instrumentId/side/type/timeInForce
 * y price. status y filled* los decide la app: no integran el payload.
 */
export const sameIdentityPayload = (
  row: OrderRequestRow,
  payload: RequestPayload,
): boolean =>
  row.instrumentId === payload.instrumentId &&
  row.side === payload.side &&
  row.type === payload.type &&
  row.timeInForce === payload.timeInForce &&
  sameDecimal(row.price, payload.price);

/** Acciones: igualdad exacta contra la columna Decimal (sin pasar por float). */
const sameTradingSize = (row: OrderRequestRow, payload: RequestPayload): boolean => {
  if (payload.side !== "BUY" && payload.side !== "SELL") {
    return false;
  }
  if (row.size === null) {
    return false;
  }
  return sameDecimal(row.size, payload.size);
};

/**
 * Mismo REQUEST de trading: huella en ambos lados ⇒ manda la huella; si falta
 * en alguno ⇒ comparación histórica por `size` (conservadora).
 */
export const sameTradingRequest = (
  row: OrderRequestRow,
  payload: RequestPayload,
): boolean =>
  row.requestFingerprint !== null && payload.requestFingerprint !== null
    ? row.requestFingerprint === payload.requestFingerprint
    : sameTradingSize(row, payload);

/**
 * Veredicto completo de un retry de TRADING: identidad primero (un cambio de
 * instrumento/lado/tipo/TIF/precio es CONFLICT aunque la huella coincida) y
 * después la regla de huella con su fallback histórico.
 */
export const classifyTradingRequest = (
  row: OrderRequestRow,
  payload: RequestPayload,
): TradingRequestOutcome =>
  sameIdentityPayload(row, payload) && sameTradingRequest(row, payload)
    ? "IDEMPOTENT_REPLAY"
    : "IDEMPOTENT_CONFLICT";
