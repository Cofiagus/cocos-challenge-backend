// Dominio de matching: evaluación PURA del cruce contra
// el precio de referencia. DECISIONS.md: NO hay matching continuo ni
// prioridad precio-tiempo en este build (fuera de alcance); matchRestingOrders
// queda documentada como punto de enchufe para la evolución, SIN disparador
// automático. Dinero siempre Decimal.

import { Decimal } from "decimal.js";
import type {
  RestingOrder,
  TimeInForce,
  TradingSide,
} from "../../contracts/index.js";

/**
 * Puerto de precios de referencia para la evaluación: última fila de
 * marketdata por `date` (close). Implementación en infra
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

/** Regla de cruce (DECISIONS.md): BUY cruza si ref ≤ límite; SELL si ref ≥ límite. */
const crosses = (
  side: TradingSide,
  limitPriceArs: Decimal,
  referencePriceArs: Decimal,
): boolean =>
  side === "BUY"
    ? referencePriceArs.lessThanOrEqualTo(limitPriceArs)
    : referencePriceArs.greaterThanOrEqualTo(limitPriceArs);

/**
 * Precio de fill con mejora (DECISIONS.md): BUY paga a lo sumo su límite
 * (min), SELL cobra a lo menos su límite (max). El cruce exacto
 * (ref == límite) llena al propio límite, sin mejora.
 */
const filledPriceWithImprovement = (
  side: TradingSide,
  limitPriceArs: Decimal,
  referencePriceArs: Decimal,
): Decimal =>
  side === "BUY"
    ? Decimal.min(limitPriceArs, referencePriceArs)
    : Decimal.max(limitPriceArs, referencePriceArs);

export const evaluateCross = (input: EvaluateCrossInput): CrossDecision => {
  // GTC nunca se llena al enviar (DECISIONS.md): siempre NEW, sin importar
  // lo que haría el cruce — no se evalúa.
  if (input.timeInForce === "GTC") {
    return { outcome: "NEW" };
  }

  // IOC/FOK: evaluación ÚNICA contra el precio de referencia.
  if (crosses(input.side, input.limitPriceArs, input.referencePriceArs)) {
    return {
      outcome: "FILLED",
      filledPriceArs: filledPriceWithImprovement(
        input.side,
        input.limitPriceArs,
        input.referencePriceArs,
      ),
    };
  }

  return { outcome: "CANCELLED", reason: "NO_IMMEDIATE_MATCH" };
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
 *
 * `referencePriceArs` es el precio de referencia DEL instrumento de las
 * órdenes: el llamador agrupa por instrumento antes de llamar (el ref de un
 * instrumento no dice nada del cruce de otro). Devuelve los fills en el
 * MISMO orden de entrada; no muta ni la lista ni las órdenes.
 */
export const matchRestingOrders = (
  referencePriceArs: Decimal,
  restingOrders: readonly RestingOrder[],
): readonly RestingOrderFill[] => {
  const fills: RestingOrderFill[] = [];

  for (const order of restingOrders) {
    if (!crosses(order.side, order.limitPriceArs, referencePriceArs)) {
      continue;
    }

    fills.push({
      orderId: order.id,
      filledPriceArs: filledPriceWithImprovement(
        order.side,
        order.limitPriceArs,
        referencePriceArs,
      ),
    });
  }

  return fills;
};