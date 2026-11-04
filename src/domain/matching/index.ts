// Firmas del dominio de matching — FASE 1 (Célula 0): SOLO firmas.
// DECISIONS.md: NO hay matching continuo ni prioridad precio-tiempo en este
// build (fuera de alcance). matchRestingOrders es una función PURA
// documentada como punto de enchufe para la evolución: SIN disparador
// automático.
//
// Los parámetros llevan `_` porque el cuerpo de FASE 1 no los usa
// (noUnusedParameters); la célula A los renombra al implementar.

import { Decimal } from "decimal.js";
import type { RestingOrder, TimeInForce, TradingSide } from "../../contracts/index.js";

/**
 * Puerto de precios de referencia para la evaluación: última fila de
 * marketdata por `date` (close). Implementación en la célula B de FASE 2
 * sobre MarketdataRepository; los tests de dominio usan un fake.
 */
export interface PriceSource {
  /** Close de la última fila por date; null si no hay marketdata (NO_PRICE). */
  readonly getReferencePriceArs: (
    instrumentId: number,
  ) => Promise<Decimal | null>;
}

/** Orden LIMIT a evaluar contra el precio de referencia. */
export interface EvaluateCrossInput {
  readonly side: TradingSide;
  readonly limitPriceArs: Decimal;
  /** GTC/IOC/FOK (DAY fuera de alcance). */
  readonly timeInForce: TimeInForce;
  /**
   * Precio de referencia YA resuelto (non-null): el REJECTED por NO_PRICE se
   * decide ANTES, en la capa de aplicación, para MARKET/IOC/FOK — evaluateCross
   * no lo resuelve.
   */
  readonly referencePriceArs: Decimal;
}

/**
 * Decisión de la evaluación única contra el precio de referencia
 * (DECISIONS.md):
 *  - FILLED con mejora si cruza: BUY a min(límite, ref), SELL a
 *    max(límite, ref); sin fills parciales;
 *  - CANCELLED con razón NO_IMMEDIATE_MATCH si IOC/FOK no cruza;
 *  - NEW si GTC (GTC nunca se llena al enviar: siempre queda resting).
 */
export type CrossDecision =
  | { readonly outcome: "FILLED"; readonly filledPriceArs: Decimal }
  | {
      readonly outcome: "CANCELLED";
      readonly reason: "NO_IMMEDIATE_MATCH";
    }
  | { readonly outcome: "NEW" };

export const evaluateCross = (
  _input: EvaluateCrossInput,
): CrossDecision => {
  throw new Error("not implemented");
};

/** Orden resting que llena, con su precio de ejecución mejorado. */
export interface RestingOrderFill {
  readonly orderId: number;
  readonly filledPriceArs: Decimal;
}

/**
 * PURA: qué órdenes NEW llenarían a este precio de referencia (cruce con
 * mejora, sin fills parciales), sin disparar nada. Documentada como el
 * punto de enchufe de la evolución (matching continuo) — en este build
 * nadie la llama desde la API.
 */
export const matchRestingOrders = (
  _referencePriceArs: Decimal,
  _restingOrders: readonly RestingOrder[],
): readonly RestingOrderFill[] => {
  throw new Error("not implemented");
};