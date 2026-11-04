// Decisiones PURAS del envío de órdenes (UC-3): con el request ya resuelto y
// los datos leídos dentro de la transacción, deciden estado, tamaño, precio de
// fill, evento y metadata — sin ports, sin `await` y sin reloj (el instante de
// decisión se recibe). Así el estado queda decidido antes de la primera
// escritura y cada rama se prueba con valores borde sin DB.

import { Decimal } from "decimal.js";
import type {
  CreateOrderRequest,
  InstrumentRecord,
  OrderEventMetadata,
  OrderEventType,
  OrderRejectionReason,
  OrderStatus,
  Reservations,
  SettledOrderMovement,
} from "../../contracts/index.js";
import {
  deriveCash,
  evaluateCross,
  sizeSharesFromAmountArs,
} from "../../domain/index.js";

/** Decisión de estado tomada dentro de la tx, antes de la primera escritura. */
export interface DecidedOrder {
  readonly status: OrderStatus;
  readonly sizeShares: number;
  readonly filledPriceArs: Decimal | null;
  readonly filledAt: Date | null;
  readonly eventType: OrderEventType;
  readonly reason: OrderRejectionReason | null;
  readonly metadata: OrderEventMetadata;
}

/** Tamaño decidido: explícito o derivado de amountArs (el residuo queda cash). */
export interface SizingDecision {
  readonly sizeShares: number;
  readonly sizingPriceArs: Decimal | null;
  readonly residualArs: Decimal | null;
}

/**
 * ¿Hay que resolver el precio de referencia? MARKET y LIMIT IOC/FOK lo
 * necesitan; LIMIT GTC queda NEW sin precio (matriz caso 7).
 */
export const needsReferencePrice = (request: CreateOrderRequest): boolean =>
  request.type === "MARKET" || request.timeInForce !== "GTC";

/** Precio límite de un LIMIT; null en MARKET (sin precio por contrato). */
export const limitPriceOf = (request: CreateOrderRequest): Decimal | null =>
  request.type === "LIMIT" ? request.price ?? null : null;

/**
 * MARKET/IOC/FOK sin precio de referencia ⇒ REJECTED NO_PRICE persistida
 * (201) con su evento. amountArs no es sizable sin precio ⇒ size 0.
 */
export const rejectForMissingPrice = (
  request: CreateOrderRequest,
  instrument: InstrumentRecord,
): DecidedOrder => ({
  status: "REJECTED",
  sizeShares: request.size ?? 0,
  filledPriceArs: null,
  filledAt: null,
  eventType: "REJECTED",
  reason: "NO_PRICE",
  metadata: { ticker: instrument.ticker },
});

/**
 * size: explícito (XOR del borde) o derivado del monto (DECISIONS.md:
 * floor(amount/precio), el residuo queda como cash). Precio de sizing:
 * MARKET ⇒ referencia (matriz caso 4); LIMIT ⇒ límite (el precio peor
 * aceptable para un BUY: nunca se compromete más que el monto a ese precio).
 */
export const resolveSizing = (
  request: CreateOrderRequest,
  referencePriceArs: Decimal | null,
  limitPriceArs: Decimal | null,
): SizingDecision => {
  if (request.size !== undefined) {
    return { sizeShares: request.size, sizingPriceArs: null, residualArs: null };
  }
  const amountArs = request.amountArs;
  if (amountArs === undefined) {
    throw new Error(
      "Envío sin size ni amountArs (inalcanzable: XOR del borde).",
    );
  }
  const sizingPriceArs =
    request.type === "MARKET" ? referencePriceArs : limitPriceArs;
  if (sizingPriceArs === null) {
    // MARKET salió con NO_PRICE antes; LIMIT lleva price por contrato (Zod).
    throw new Error(
      "Precio de sizing no resuelto (inalcanzable tras NO_PRICE/contrato).",
    );
  }
  const sizeShares = sizeSharesFromAmountArs(amountArs, sizingPriceArs);
  const residualArs = amountArs.minus(
    new Decimal(String(sizeShares)).mul(sizingPriceArs),
  );
  return { sizeShares, sizingPriceArs, residualArs };
};

/** Metadata de auditoría común (dinero como string de 2 decimales, nunca float). */
export const buildAuditBase = (
  instrument: InstrumentRecord,
  request: CreateOrderRequest,
  referencePriceArs: Decimal | null,
  sizing: SizingDecision,
): OrderEventMetadata => ({
  ticker: instrument.ticker,
  referencePriceArs:
    referencePriceArs === null ? null : referencePriceArs.toFixed(2),
  sizingPriceArs:
    sizing.sizingPriceArs === null ? null : sizing.sizingPriceArs.toFixed(2),
  sizeDerivedFromAmount: request.size === undefined,
  residualArs:
    sizing.residualArs === null ? null : sizing.residualArs.toFixed(2),
});

/** size 0 (sólo derivable de amountArs) ⇒ REJECTED ZERO_SIZE persistida. */
export const rejectForZeroSize = (
  auditBase: OrderEventMetadata,
): DecidedOrder => ({
  status: "REJECTED",
  sizeShares: 0,
  filledPriceArs: null,
  filledAt: null,
  eventType: "REJECTED",
  reason: "ZERO_SIZE",
  metadata: auditBase,
});

/**
 * Posición FILLED de UN instrumento: BUY suma, SELL resta; los movimientos de
 * cash (CASH_IN/CASH_OUT) no son posiciones y no la alteran.
 */
export const positionSharesFor = (
  movements: readonly SettledOrderMovement[],
  instrumentId: number,
): number => {
  let positionShares = 0;
  for (const movement of movements) {
    if (movement.instrumentId !== instrumentId) continue;
    if (movement.side === "BUY") positionShares += movement.sizeShares;
    else if (movement.side === "SELL") positionShares -= movement.sizeShares;
  }
  return positionShares;
};

/** Datos ya leídos dentro de la tx para validar fondos/tenencia. */
export interface FundsAssessmentInput {
  readonly request: CreateOrderRequest;
  readonly instrumentId: number;
  readonly sizeShares: number;
  readonly referencePriceArs: Decimal | null;
  readonly limitPriceArs: Decimal | null;
  readonly movements: readonly SettledOrderMovement[];
  readonly reservations: Reservations;
  readonly auditBase: OrderEventMetadata;
}

/**
 * Costo a validar: MARKET ⇒ ref; LIMIT ⇒ límite (reserva implícita de un GTC
 * y tope peor de un IOC/FOK que cruza — paga ≤ límite).
 */
const assessBuyFunds = (
  input: FundsAssessmentInput,
): DecidedOrder | null => {
  const validationPriceArs =
    input.request.type === "MARKET"
      ? input.referencePriceArs
      : input.limitPriceArs;
  if (validationPriceArs === null) {
    throw new Error("Precio de validación no resuelto (inalcanzable).");
  }
  const costArs = new Decimal(String(input.sizeShares)).mul(validationPriceArs);
  const cashAvailableArs = deriveCash(input.movements).minus(
    input.reservations.cashReservedArs,
  );
  if (!costArs.greaterThan(cashAvailableArs)) return null;
  return {
    status: "REJECTED",
    sizeShares: input.sizeShares,
    filledPriceArs: null,
    filledAt: null,
    eventType: "REJECTED",
    reason: "INSUFFICIENT_FUNDS",
    metadata: {
      ...input.auditBase,
      requiredCostArs: costArs.toFixed(2),
      cashAvailableArs: cashAvailableArs.toFixed(2),
    },
  };
};

/**
 * SELL: vendible = posición FILLED del instrumento − sharesReserved del MISMO
 * instrumento (posición negativa del seed ⇒ vendible < 0).
 */
const assessSellPosition = (
  input: FundsAssessmentInput,
): DecidedOrder | null => {
  const positionShares = positionSharesFor(
    input.movements,
    input.instrumentId,
  );
  const reservedShares =
    input.reservations.sharesReservedByInstrument.get(input.instrumentId) ?? 0;
  const sellableShares = positionShares - reservedShares;
  if (input.sizeShares <= sellableShares) return null;
  return {
    status: "REJECTED",
    sizeShares: input.sizeShares,
    filledPriceArs: null,
    filledAt: null,
    eventType: "REJECTED",
    reason: "INSUFFICIENT_POSITION",
    metadata: {
      ...input.auditBase,
      positionShares,
      reservedShares,
      sellableShares,
    },
  };
};

/** Rechazo por fondos/tenencia de la validación; null si alcanza. */
export const assessFunds = (
  input: FundsAssessmentInput,
): DecidedOrder | null =>
  input.request.side === "BUY"
    ? assessBuyFunds(input)
    : assessSellPosition(input);

/** Datos de la decisión de una orden que ya pasó la validación de fondos. */
export interface AcceptedOrderInput {
  readonly request: CreateOrderRequest;
  readonly sizeShares: number;
  readonly referencePriceArs: Decimal | null;
  readonly limitPriceArs: Decimal | null;
  readonly auditBase: OrderEventMetadata;
  /** Instante de decisión (después de las lecturas de fondos). */
  readonly decidedAt: Date;
}

/** LIMIT GTC ⇒ NEW: nunca se llena al enviar. */
const decideGoodTillCancelled = (
  input: AcceptedOrderInput,
): DecidedOrder => ({
  status: "NEW",
  sizeShares: input.sizeShares,
  filledPriceArs: null,
  filledAt: null,
  eventType: "ACCEPTED",
  reason: null,
  metadata: input.auditBase,
});

/** No cruzó: CANCELLED persistida (201) con su razón, sin fills ni reserva. */
const decideCancelled = (
  input: AcceptedOrderInput,
  reason: OrderRejectionReason,
  limitPriceArs: Decimal,
): DecidedOrder => ({
  status: "CANCELLED",
  sizeShares: input.sizeShares,
  filledPriceArs: null,
  filledAt: null,
  eventType: "CANCELLED",
  reason,
  metadata: { ...input.auditBase, limitPriceArs: limitPriceArs.toFixed(2) },
});

/** Cruzó: FILLED con mejora (BUY a min(límite, ref), SELL a max). */
const decideFilledCross = (
  input: AcceptedOrderInput,
  filledPriceArs: Decimal,
  limitPriceArs: Decimal,
): DecidedOrder => ({
  status: "FILLED",
  sizeShares: input.sizeShares,
  filledPriceArs,
  filledAt: input.decidedAt,
  eventType: "ACCEPTED",
  reason: null,
  metadata: { ...input.auditBase, limitPriceArs: limitPriceArs.toFixed(2) },
});

/** LIMIT IOC/FOK: evaluación ÚNICA contra el ref (dominio A). */
const decideImmediate = (
  input: AcceptedOrderInput,
): DecidedOrder => {
  const { referencePriceArs, limitPriceArs } = input;
  if (referencePriceArs === null) {
    throw new Error(
      "IOC/FOK sin precio de referencia (inalcanzable: NO_PRICE salió).",
    );
  }
  if (limitPriceArs === null) {
    throw new Error("LIMIT sin límite (inalcanzable: contrato del borde).");
  }
  const decision = evaluateCross({
    side: input.request.side,
    limitPriceArs,
    timeInForce: input.request.timeInForce,
    referencePriceArs,
  });
  if (decision.outcome === "CANCELLED") {
    return decideCancelled(input, decision.reason, limitPriceArs);
  }
  if (decision.outcome === "NEW") {
    // GTC salió antes: evaluateCross nunca responde NEW para IOC/FOK.
    throw new Error("Evaluación IOC/FOK sin decisión (inalcanzable).");
  }
  return decideFilledCross(input, decision.filledPriceArs, limitPriceArs);
};

/** LIMIT: GTC queda NEW; IOC/FOK se evalúan contra el precio de referencia. */
export const decideLimitOrder = (
  input: AcceptedOrderInput,
): DecidedOrder =>
  input.request.timeInForce === "GTC"
    ? decideGoodTillCancelled(input)
    : decideImmediate(input);

/** MARKET ⇒ FILLED al precio de referencia en la misma transacción. */
export const decideMarketFill = (
  input: AcceptedOrderInput,
): DecidedOrder => {
  if (input.referencePriceArs === null) {
    throw new Error(
      "MARKET sin precio de referencia (inalcanzable: NO_PRICE salió).",
    );
  }
  return {
    status: "FILLED",
    sizeShares: input.sizeShares,
    filledPriceArs: input.referencePriceArs,
    filledAt: input.decidedAt,
    eventType: "ACCEPTED",
    reason: null,
    metadata: input.auditBase,
  };
};

/** Decisión de estado con todos los datos, ANTES de la primera escritura. */
export const decideAcceptedOrder = (
  input: AcceptedOrderInput,
): DecidedOrder =>
  input.request.type === "MARKET"
    ? decideMarketFill(input)
    : decideLimitOrder(input);
