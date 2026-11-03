// UC-3 — submitOrder (FASE 3 — Célula E): caso de uso completo del envío.
//
// Orquesta dominio (A) + repos (B) + contratos DENTRO de UNA transacción con
// lock por usuario (withUserTransaction — DECISIONS.md), en el orden que hace
// válida la concurrencia y la idempotencia:
//
//   1. userExists (tx)                       ⇒ 404 USER_NOT_FOUND.
//   2. instrumento por instrumentId|ticker   ⇒ 404 / MONEDA ⇒ 400 SIN orden.
//   3. precio de referencia (getLatestSnapshot, dentro de la tx): lo necesitan
//      MARKET y LIMIT IOC/FOK; LIMIT GTC NO lo resuelve (queda NEW — matriz
//      caso 7). Sin precio ⇒ REJECTED NO_PRICE persistida (201).
//   4. size: explícito o sizeSharesFromAmountArs(amountArs, precio de sizing)
//      ⇒ size 0 ⇒ REJECTED ZERO_SIZE persistida (201).
//   5. fondos/tenencia LEÍDOS dentro de la tx (listSettledMovements/
//      listRestingOrders con tx): BUY ⇒ size × (MARKET→ref, LIMIT→límite) ≤
//      cashSettled − cashReserved; SELL ⇒ size ≤ posición FILLED −
//      sharesReserved del instrumento. Falla ⇒ REJECTED INSUFFICIENT_* (201).
//   6. createOrder(draft, tx) es la PRIMERA ESCRITURA de la tx (claim
//      idempotente con ON CONFLICT DO NOTHING — B): el draft completo, status
//      incluido, se decide ANTES con las lecturas de 3–5 (las lecturas no son
//      escrituras). IDEMPOTENT_REPLAY ⇒ la orden original (201, sin evento);
//      IDEMPOTENT_CONFLICT ⇒ 409 (B ya comparó el payload).
//   7. appendOrderEvent ACCEPTED/REJECTED/CANCELLED en la MISMA tx.
//
// La respuesta (router) es 201 OrderResponse SIEMPRE que se persistió
// (FILLED/NEW/REJECTED/CANCELLED — DECISIONS.md). Dinero SIEMPRE Decimal
// (AGENTS.md): nunca float, y a metadata jsonb como string de 2 decimales.

import { Decimal } from "decimal.js";
import {
  API_ERROR_CODES,
  type ApiErrorCode,
  type CreateOrderRequest,
  type InstrumentRecord,
  type OrderDraft,
  type OrderEventMetadata,
  type OrderEventType,
  type OrderRejectionReason,
  type OrderStatus,
  type OrderRecord,
  type TransactionContext,
} from "../../contracts/index.js";
import {
  deriveCash,
  deriveReservations,
  evaluateCross,
  sizeSharesFromAmountArs,
} from "../../domain/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";

/**
 * Código de error del envío: los códigos estables del contrato
 * (API_ERROR_CODES), incluido INSTRUMENT_NOT_FOUND (404 de instrumento
 * inexistente por instrumentId|ticker).
 */
export type SubmitOrderErrorCode = ApiErrorCode;

/** Error de aplicación del envío: el router lo mapea a status + apiErrorBody. */
export class SubmitOrderError extends Error {
  constructor(
    readonly status: number,
    readonly code: SubmitOrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubmitOrderError";
  }
}

/** Deps del caso de uso: las INTERFACES de src/domain/ports, nunca concreciones. */
export interface SubmitOrderDeps {
  /** Escritura de orders + auditoría + la transacción con lock por usuario. */
  readonly orders: OrderRepository;
  /** Lecturas del portfolio (userExists, fondos/tenencia del envío). */
  readonly portfolioRead: PortfolioReadRepository;
  /** Resolución del instrumento (instrumentId|ticker). */
  readonly instruments: InstrumentRepository;
  /** Precio de referencia (última vela por date). */
  readonly marketdata: MarketdataRepository;
}

/** Entrada del caso de uso: el body YA validado por Zod en el borde. */
export interface SubmitOrderInput {
  readonly userId: number;
  readonly request: CreateOrderRequest;
  /** Idempotency-Key del header; null si no viene (es opcional). */
  readonly idempotencyKey: string | null;
}

/** Salida: la fila persistida + la razón (REJECTED/CANCELLED; null si NEW/FILLED). */
export interface SubmitOrderResult {
  readonly order: OrderRecord;
  readonly reason: OrderRejectionReason | null;
}

/** Decisión de estado tomada dentro de la tx, antes de la primera escritura. */
interface DecidedOrder {
  readonly status: OrderStatus;
  readonly sizeShares: number;
  readonly filledPriceArs: Decimal | null;
  readonly filledAt: Date | null;
  readonly eventType: OrderEventType;
  readonly reason: OrderRejectionReason | null;
  readonly metadata: OrderEventMetadata;
}

/**
 * Persiste la decisión: createOrder como PRIMERA escritura (claim idempotente)
 * y el evento de auditoría en la MISMA tx. Nada de esto corre si una
 * SubmitOrderError salió antes (el lock se libera con el rollback).
 */
const persistDecidedOrder = async (
  deps: SubmitOrderDeps,
  tx: TransactionContext,
  decided: DecidedOrder,
  base: Omit<
    OrderDraft,
    "status" | "sizeShares" | "filledPriceArs" | "filledAt"
  >,
): Promise<SubmitOrderResult> => {
  const draft: OrderDraft = {
    ...base,
    status: decided.status,
    sizeShares: decided.sizeShares,
    filledPriceArs: decided.filledPriceArs,
    filledAt: decided.filledAt,
  };

  // PRIMERA ESCRITURA de la tx de envío: claim idempotente (ON CONFLICT — B).
  const created = await deps.orders.createOrder(draft, tx);

  if (created.outcome === "IDEMPOTENT_CONFLICT") {
    throw new SubmitOrderError(
      409,
      API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      `Idempotency-Key ya usada con otro payload (orden existente ${String(created.order.id)}).`,
    );
  }
  if (created.outcome === "IDEMPOTENT_REPLAY") {
    // Misma key + mismo payload: la orden ORIGINAL, 201 sin nuevo evento.
    return { order: created.order, reason: null };
  }

  // Auditoría en la MISMA tx que la mutación (DECISIONS.md).
  await deps.orders.appendOrderEvent(
    {
      orderId: created.order.id,
      eventType: decided.eventType,
      reason: decided.reason,
      metadata: decided.metadata,
    },
    tx,
  );

  return { order: created.order, reason: decided.reason };
};

/** Resolución del instrumento por instrumentId|ticker (XOR validado en el borde). */
const resolveInstrument = async (
  deps: SubmitOrderDeps,
  request: CreateOrderRequest,
  tx: TransactionContext,
): Promise<InstrumentRecord | null> => {
  if (request.instrumentId !== undefined) {
    return deps.instruments.findById(request.instrumentId, tx);
  }
  if (request.ticker !== undefined) {
    return deps.instruments.findByTicker(request.ticker, tx);
  }
  return null; // inalcanzable: el borde (Zod) exige exactamente uno
};

export const submitOrder = async (
  deps: SubmitOrderDeps,
  input: SubmitOrderInput,
): Promise<SubmitOrderResult> => {
  const { userId, request } = input;

  // UNA transacción con pg_advisory_xact_lock(userId) (B): serializa los
  // submits del usuario; TODO lo de abajo corre con el lock tomado.
  return deps.orders.withUserTransaction(userId, async (tx) => {
    // 404 de usuario (lectura en la tx: el lock ya está tomado).
    const userExists = await deps.portfolioRead.userExists(userId, tx);
    if (!userExists) {
      throw new SubmitOrderError(
        404,
        API_ERROR_CODES.USER_NOT_FOUND,
        `No existe el usuario ${String(userId)}.`,
      );
    }

    // Instrumento (XOR del borde): inexistente ⇒ 404; MONEDA ⇒ 400 SIN orden.
    const instrument = await resolveInstrument(deps, request, tx);
    const instrumentRef =
      request.instrumentId !== undefined
        ? `instrumentId ${String(request.instrumentId)}`
        : `ticker ${String(request.ticker)}`;
    if (instrument === null) {
      throw new SubmitOrderError(
        404,
        API_ERROR_CODES.INSTRUMENT_NOT_FOUND,
        `No existe el instrumento (${instrumentRef}).`,
      );
    }
    if (instrument.type === "MONEDA") {
      throw new SubmitOrderError(
        400,
        API_ERROR_CODES.INSTRUMENT_NOT_OPERABLE,
        `${instrument.ticker} es MONEDA: no operable (DECISIONS.md).`,
      );
    }

    // Precio de referencia (dentro de la tx): MARKET y LIMIT IOC/FOK lo
    // necesitan; LIMIT GTC NO lo resuelve (matriz caso 7: NEW sin precio).
    const needsReferencePrice =
      request.type === "MARKET" || request.timeInForce !== "GTC";
    let referencePriceArs: Decimal | null = null;
    if (needsReferencePrice) {
      const snapshot = await deps.marketdata.getLatestSnapshot(
        instrument.id,
        tx,
      );
      referencePriceArs = snapshot === null ? null : snapshot.closeArs;
    }

    const datetime = new Date(); // hora de envío/aceptación
    const limitPriceArs: Decimal | null =
      request.type === "LIMIT" ? request.price ?? null : null;

    // Campos comunes del draft (el status/fill se decide y agrega abajo).
    const base: Omit<
      OrderDraft,
      "status" | "sizeShares" | "filledPriceArs" | "filledAt"
    > = {
      userId,
      instrumentId: instrument.id,
      side: request.side,
      type: request.type,
      timeInForce: request.timeInForce,
      priceArs: limitPriceArs,
      idempotencyKey: input.idempotencyKey,
      datetime,
    };

    // MARKET/IOC/FOK sin precio de referencia ⇒ REJECTED NO_PRICE persistida
    // (201) con su evento. amountArs no es sizable sin precio ⇒ size 0.
    if (referencePriceArs === null && needsReferencePrice) {
      return persistDecidedOrder(
        deps,
        tx,
        {
          status: "REJECTED",
          sizeShares: request.size ?? 0,
          filledPriceArs: null,
          filledAt: null,
          eventType: "REJECTED",
          reason: "NO_PRICE",
          metadata: { ticker: instrument.ticker },
        },
        base,
      );
    }

    // size: explícito (XOR del borde) o derivado del monto (DECISIONS.md:
    // floor(amount/precio), el residuo queda como cash).
    let sizeShares: number;
    let sizingPriceArs: Decimal | null = null;
    let residualArs: Decimal | null = null;
    if (request.size !== undefined) {
      sizeShares = request.size;
    } else {
      const amountArs = request.amountArs;
      if (amountArs === undefined) {
        throw new Error(
          "Envío sin size ni amountArs (inalcanzable: XOR del borde).",
        );
      }
      // Precio de sizing: MARKET ⇒ referencia (matriz caso 4:
      // floor(amount/ref)); LIMIT ⇒ límite (el precio peor aceptable para un
      // BUY: nunca se compromete más que el monto a ese precio).
      const price = request.type === "MARKET" ? referencePriceArs : limitPriceArs;
      if (price === null) {
        // MARKET salió con NO_PRICE arriba; LIMIT lleva price por contrato (Zod).
        throw new Error(
          "Precio de sizing no resuelto (inalcanzable tras NO_PRICE/contrato).",
        );
      }
      sizeShares = sizeSharesFromAmountArs(amountArs, price);
      sizingPriceArs = price;
      residualArs = amountArs.minus(new Decimal(String(sizeShares)).mul(price));
    }

    // Metadata de auditoría común (dinero como string de 2 decimales, nunca float).
    const auditBase: OrderEventMetadata = {
      ticker: instrument.ticker,
      referencePriceArs:
        referencePriceArs === null ? null : referencePriceArs.toFixed(2),
      sizingPriceArs: sizingPriceArs === null ? null : sizingPriceArs.toFixed(2),
      sizeDerivedFromAmount: request.size === undefined,
      residualArs: residualArs === null ? null : residualArs.toFixed(2),
    };

    // size 0 (sólo derivable de amountArs) ⇒ REJECTED ZERO_SIZE persistida.
    if (sizeShares === 0) {
      return persistDecidedOrder(
        deps,
        tx,
        {
          status: "REJECTED",
          sizeShares: 0,
          filledPriceArs: null,
          filledAt: null,
          eventType: "REJECTED",
          reason: "ZERO_SIZE",
          metadata: auditBase,
        },
        base,
      );
    }

    // Fondos/tenencia DENTRO de la tx (validez de la validación): dos submits
    // que juntos exceden el cash ⇒ el segundo ya ve el cash debitado (lock).
    // Awaits SECUENCIALES: Prisma no documenta queries paralelas dentro de
    // una $transaction interactiva, y dos SELECT no ganan nada medible.
    const movements = await deps.portfolioRead.listSettledMovements(userId, tx);
    const restingOrders = await deps.portfolioRead.listRestingOrders(userId, tx);
    const reservations = deriveReservations(restingOrders);

    if (request.side === "BUY") {
      // Costo a validar: MARKET ⇒ ref; LIMIT ⇒ límite (reserva implícita de un
      // GTC y tope peor de un IOC/FOK que cruza — paga ≤ límite).
      const validationPriceArs =
        request.type === "MARKET" ? referencePriceArs : limitPriceArs;
      if (validationPriceArs === null) {
        throw new Error("Precio de validación no resuelto (inalcanzable).");
      }
      const costArs = new Decimal(String(sizeShares)).mul(validationPriceArs);
      const cashAvailableArs = deriveCash(movements).minus(
        reservations.cashReservedArs,
      );
      if (costArs.greaterThan(cashAvailableArs)) {
        return persistDecidedOrder(
          deps,
          tx,
          {
            status: "REJECTED",
            sizeShares,
            filledPriceArs: null,
            filledAt: null,
            eventType: "REJECTED",
            reason: "INSUFFICIENT_FUNDS",
            metadata: {
              ...auditBase,
              requiredCostArs: costArs.toFixed(2),
              cashAvailableArs: cashAvailableArs.toFixed(2),
            },
          },
          base,
        );
      }
    } else {
      // SELL: vendible = posición FILLED del instrumento − sharesReserved
      // del MISMO instrumento (posición negativa del seed ⇒ vendible < 0).
      let positionShares = 0;
      for (const movement of movements) {
        if (movement.instrumentId !== instrument.id) continue;
        if (movement.side === "BUY") positionShares += movement.sizeShares;
        else if (movement.side === "SELL") positionShares -= movement.sizeShares;
      }
      const reservedShares =
        reservations.sharesReservedByInstrument.get(instrument.id) ?? 0;
      const sellableShares = positionShares - reservedShares;
      if (sizeShares > sellableShares) {
        return persistDecidedOrder(
          deps,
          tx,
          {
            status: "REJECTED",
            sizeShares,
            filledPriceArs: null,
            filledAt: null,
            eventType: "REJECTED",
            reason: "INSUFFICIENT_POSITION",
            metadata: {
              ...auditBase,
              positionShares,
              reservedShares,
              sellableShares,
            },
          },
          base,
        );
      }
    }

    // Decisión de estado (con todos los datos, ANTES de la primera escritura).
    if (request.type === "MARKET") {
      if (referencePriceArs === null) {
        throw new Error(
          "MARKET sin precio de referencia (inalcanzable: NO_PRICE salió).",
        );
      }
      // MARKET ⇒ FILLED a ref en la misma transacción (DECISIONS.md).
      return persistDecidedOrder(
        deps,
        tx,
        {
          status: "FILLED",
          sizeShares,
          filledPriceArs: referencePriceArs,
          filledAt: new Date(),
          eventType: "ACCEPTED",
          reason: null,
          metadata: auditBase,
        },
        base,
      );
    }

    if (request.timeInForce === "GTC") {
      // LIMIT GTC ⇒ NEW: nunca se llena al enviar; la reserva implícita es
      // exactamente lo validado arriba (size × límite).
      return persistDecidedOrder(
        deps,
        tx,
        {
          status: "NEW",
          sizeShares,
          filledPriceArs: null,
          filledAt: null,
          eventType: "ACCEPTED",
          reason: null,
          metadata: auditBase,
        },
        base,
      );
    }

    // LIMIT IOC/FOK: evaluación ÚNICA contra el ref (dominio A). ref non-null
    // (NO_PRICE salió) y límite non-null (LIMIT exige price — Zod).
    if (referencePriceArs === null) {
      throw new Error(
        "IOC/FOK sin precio de referencia (inalcanzable: NO_PRICE salió).",
      );
    }
    if (limitPriceArs === null) {
      throw new Error("LIMIT sin límite (inalcanzable: contrato del borde).");
    }
    const decision = evaluateCross({
      side: request.side,
      limitPriceArs,
      timeInForce: request.timeInForce,
      referencePriceArs,
    });

    if (decision.outcome === "CANCELLED") {
      // No cruzó: CANCELLED persistida (201) con su razón, sin fills ni reserva.
      return persistDecidedOrder(
        deps,
        tx,
        {
          status: "CANCELLED",
          sizeShares,
          filledPriceArs: null,
          filledAt: null,
          eventType: "CANCELLED",
          reason: decision.reason,
          metadata: { ...auditBase, limitPriceArs: limitPriceArs.toFixed(2) },
        },
        base,
      );
    }

    if (decision.outcome === "NEW") {
      // GTC salió antes: evaluateCross nunca responde NEW para IOC/FOK.
      throw new Error("Evaluación IOC/FOK sin decisión (inalcanzable).");
    }

    // Cruzó: FILLED con mejora (BUY a min(límite, ref), SELL a max).
    return persistDecidedOrder(
      deps,
      tx,
      {
        status: "FILLED",
        sizeShares,
        filledPriceArs: decision.filledPriceArs,
        filledAt: new Date(),
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ...auditBase, limitPriceArs: limitPriceArs.toFixed(2) },
      },
      base,
    );
  });
};