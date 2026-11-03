// UC-5 — submitTransfer (FASE 4 — Célula G): transferencias de cash.
//
// DECISIONS.md: las transferencias se modelan como ORDERS del instrumento
// MONEDA del cash (ARS — seed id 66, docs/database.md §2) con la convención
// del seed: price = 1.00 (un peso) y size = pesos ⇒ el cash que proyecta
// deriveCash (size × price sobre FILLED) es exactamente el monto movido.
// CASH_IN/CASH_OUT NO pasan por la regla "MONEDA no operable": esa
// validación es para trading (BUY/SELL de un instrumento) — éstas son
// movimientos de cash sobre el propio instrumento MONEDA.
//
// Espeja submitOrder (Célula E, UC-3) paso a paso — es el MISMO mecanismo
// de orders, sin instrumento del request ni precio de referencia:
//
//   1. userExists (tx)                       ⇒ 404 USER_NOT_FOUND.
//   2. instrumento del cash por ticker (ARS, dentro de la tx): el seed lo
//      garantiza (docs §2); si faltara es corrupción ⇒ 500 no controlado.
//   3. size = floor(amountArs / 1.00) — la MISMA regla de sizing de
//      DECISIONS.md (amountArs ⇒ size derivado); con price 1.00 es el
//      monto en pesos enteros. size 0 (amountArs < 1 peso) ⇒ REJECTED
//      ZERO_SIZE persistida (201), como en E.
//   4. CASH_IN (depósito): SIN validación de fondos ⇒ FILLED inmediata.
//      CASH_OUT (extracción): cash DISPONIBLE leído DENTRO de la tx
//      (listSettledMovements + listRestingOrders con tx → deriveCash −
//      deriveReservations.cashReservedArs): monto > disponible ⇒ REJECTED
//      INSUFFICIENT_FUNDS persistida (201) con el evento y metadata
//      (disponible y requerido). OJO: valida contra el DISPONIBLE
//      (settled − reservas), NO contra el settled — dos CASH_OUT
//      simultáneas que juntas exceden quedan una FILLED y una REJECTED
//      gracias al pg_advisory_xact_lock por usuario.
//   5. createOrder(draft, tx) es la PRIMERA ESCRITURA (claim idempotente
//      con ON CONFLICT DO NOTHING — célula B): el draft completo, status
//      incluido, se decide ANTES con las lecturas de 2–4. IDEMPOTENT_REPLAY
//      ⇒ la orden original (201, sin evento nuevo); IDEMPOTENT_CONFLICT ⇒
//      409 (B ya comparó el payload).
//   6. appendOrderEvent ACCEPTED/REJECTED en la MISMA tx (DECISIONS.md:
//      auditoría en la misma transacción que la mutación).
//
// La respuesta (router) es 201 OrderResponse SIEMPRE que se persistió
// (FILLED o REJECTED — DECISIONS.md). Dinero SIEMPRE Decimal (AGENTS.md):
// nunca float, y a metadata jsonb como string de 2 decimales.

import { Decimal } from "decimal.js";
import {
  API_ERROR_CODES,
  type ApiErrorCode,
  type OrderDraft,
  type OrderEventMetadata,
  type OrderEventType,
  type OrderRejectionReason,
  type OrderRecord,
  type OrderStatus,
  type TransactionContext,
  type TransferSide,
} from "../../contracts/index.js";
import {
  deriveCash,
  deriveReservations,
  sizeSharesFromAmountArs,
} from "../../domain/index.js";
import type {
  InstrumentRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";

/** Ticker del instrumento MONEDA del cash (seed: ARS, id 66 — fixtures). */
const CASH_TICKER = "ARS";

/** Precio unitario del cash: un peso (convención del seed: size = pesos). */
const CASH_UNIT_PRICE_ARS = new Decimal("1.00");

/**
 * Error de aplicación de la transferencia: el router lo mapea a status +
 * apiErrorBody. A diferencia de E, NO hay códigos extra: USER_NOT_FOUND y
 * IDEMPOTENCY_CONFLICT (los únicos que emite) ya viven en API_ERROR_CODES.
 */
export class SubmitTransferError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubmitTransferError";
  }
}

/** Deps del caso de uso: las INTERFACES de src/domain/ports, nunca concreciones. */
export interface SubmitTransferDeps {
  /** Escritura de orders + auditoría + la transacción con lock por usuario. */
  readonly orders: OrderRepository;
  /** Lecturas del portfolio (userExists + fondos disponibles del CASH_OUT). */
  readonly portfolioRead: PortfolioReadRepository;
  /** Resolución del instrumento del cash (ticker ARS del seed). */
  readonly instruments: InstrumentRepository;
}

/** Entrada del caso de uso: el body YA validado por Zod en el borde. */
export interface SubmitTransferInput {
  readonly userId: number;
  /** Monto en ARS (> 0 — PositiveArsInputSchema en el borde). */
  readonly amountArs: Decimal;
  readonly side: TransferSide;
  /** Idempotency-Key del header; null si no viene (es opcional). */
  readonly idempotencyKey: string | null;
}

/** Salida: la fila persistida + la razón (REJECTED; null si FILLED). */
export interface SubmitTransferResult {
  readonly order: OrderRecord;
  readonly reason: OrderRejectionReason | null;
}

/** Decisión de estado tomada dentro de la tx, antes de la primera escritura. */
interface DecidedTransfer {
  readonly status: OrderStatus;
  readonly sizeShares: number;
  readonly filledPriceArs: Decimal | null;
  readonly filledAt: Date | null;
  readonly eventType: OrderEventType;
  readonly reason: OrderRejectionReason | null;
  readonly metadata: OrderEventMetadata;
}

/**
 * Persiste la decisión: createOrder como PRIMERA escritura (claim
 * idempotente) y el evento de auditoría en la MISMA tx. Nada de esto corre
 * si una SubmitTransferError salió antes (el lock se libera con rollback).
 */
const persistDecidedTransfer = async (
  deps: SubmitTransferDeps,
  tx: TransactionContext,
  decided: DecidedTransfer,
  base: Omit<
    OrderDraft,
    "status" | "sizeShares" | "filledPriceArs" | "filledAt"
  >,
): Promise<SubmitTransferResult> => {
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
    throw new SubmitTransferError(
      409,
      API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      `Idempotency-Key ya usada con otro payload (orden existente ${String(created.order.id)}).`,
    );
  }
  if (created.outcome === "IDEMPOTENT_REPLAY") {
    // Misma key + mismo payload: la orden ORIGINAL, 201 sin nuevo evento
    // (misma semántica que E — el reason del original vive en order_events).
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

export const submitTransfer = async (
  deps: SubmitTransferDeps,
  input: SubmitTransferInput,
): Promise<SubmitTransferResult> => {
  const { userId, amountArs, side } = input;

  // UNA transacción con pg_advisory_xact_lock(userId) (B): serializa las
  // transferencias y los submits del usuario; TODO lo de abajo corre con el
  // lock tomado.
  return deps.orders.withUserTransaction(userId, async (tx) => {
    // 404 de usuario (lectura en la tx: el lock ya está tomado).
    const userExists = await deps.portfolioRead.userExists(userId, tx);
    if (!userExists) {
      throw new SubmitTransferError(
        404,
        API_ERROR_CODES.USER_NOT_FOUND,
        `No existe el usuario ${String(userId)}.`,
      );
    }

    // Instrumento del cash: la MONEDA ARS del seed (ticker exacto). El seed
    // la garantiza (docs/database.md §2): no encontrarla es corrupción de
    // datos ⇒ error no controlado (500 por defecto de Express).
    const cashInstrument = await deps.instruments.findByTicker(CASH_TICKER);
    if (cashInstrument === null) {
      throw new Error(
        `No existe el instrumento del cash (ticker ${CASH_TICKER}): seed corrupto.`,
      );
    }

    // size en pesos con la MISMA regla de sizing de DECISIONS.md:
    // floor(amountArs / 1.00) — con price 1.00 es el monto pedido en pesos
    // enteros (la fracción de peso no persiste en `size` INT; queda como
    // residuo documentado en la metadata del evento).
    const sizeShares = sizeSharesFromAmountArs(amountArs, CASH_UNIT_PRICE_ARS);
    const residualArs = amountArs.minus(
      new Decimal(String(sizeShares)).mul(CASH_UNIT_PRICE_ARS),
    );

    const datetime = new Date(); // hora de envío/aceptación

    // Campos comunes del draft (el status/fill se decide y agrega abajo).
    // type MARKET + tif GTC: convención del seed para las filas CASH (no hay
    // ni límite ni referencia — el "precio de mercado" del cash es 1.00).
    const base: Omit<
      OrderDraft,
      "status" | "sizeShares" | "filledPriceArs" | "filledAt"
    > = {
      userId,
      instrumentId: cashInstrument.id,
      side,
      type: "MARKET",
      timeInForce: "GTC",
      priceArs: CASH_UNIT_PRICE_ARS,
      idempotencyKey: input.idempotencyKey,
      datetime,
    };

    // Metadata de auditoría común (dinero como string de 2 decimales).
    const auditBase: OrderEventMetadata = {
      ticker: cashInstrument.ticker,
      amountArs: amountArs.toFixed(2),
      residualArs: residualArs.toFixed(2),
    };

    // size 0 (0 < amountArs < 1 peso) ⇒ REJECTED ZERO_SIZE persistida (201)
    // — la misma regla de DECISIONS.md que E aplica al size derivado.
    if (sizeShares === 0) {
      return persistDecidedTransfer(deps, tx, {
        status: "REJECTED",
        sizeShares: 0,
        filledPriceArs: null,
        filledAt: null,
        eventType: "REJECTED",
        reason: "ZERO_SIZE",
        metadata: auditBase,
      }, base);
    }

    // CASH_IN (depósito): SIN validación de fondos ⇒ FILLED inmediata a
    // 1.00 (convención del seed; el disponible sube exactamente el monto).
    if (side === "CASH_IN") {
      return persistDecidedTransfer(deps, tx, {
        status: "FILLED",
        sizeShares,
        filledPriceArs: CASH_UNIT_PRICE_ARS,
        filledAt: new Date(),
        eventType: "ACCEPTED",
        reason: null,
        metadata: auditBase,
      }, base);
    }

    // CASH_OUT (extracción): fondos DENTRO de la tx (validez de la
    // validación): disponible = settled − reservas (deriveCash sobre los
    // movimientos FILLED menos deriveReservations sobre las NEW).
    const [movements, restingOrders] = await Promise.all([
      deps.portfolioRead.listSettledMovements(userId, tx),
      deps.portfolioRead.listRestingOrders(userId, tx),
    ]);
    const cashAvailableArs = deriveCash(movements).minus(
      deriveReservations(restingOrders).cashReservedArs,
    );
    const requiredArs = new Decimal(String(sizeShares)).mul(
      CASH_UNIT_PRICE_ARS,
    );

    if (requiredArs.greaterThan(cashAvailableArs)) {
      // No alcanza el DISPONIBLE (aunque alcance el settled): REJECTED
      // persistida (201) con el evento y la metadata del porqué.
      return persistDecidedTransfer(deps, tx, {
        status: "REJECTED",
        sizeShares, // el monto pedido (no 0: no hubo floor que lo anule)
        filledPriceArs: null,
        filledAt: null,
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ...auditBase,
          requiredArs: requiredArs.toFixed(2),
          cashAvailableArs: cashAvailableArs.toFixed(2),
        },
      }, base);
    }

    // Alcanza el disponible ⇒ FILLED inmediata a 1.00 (como en E: MARKET se
    // ejecuta en la misma transacción; el "precio" del cash es el unitario).
    return persistDecidedTransfer(deps, tx, {
      status: "FILLED",
      sizeShares,
      filledPriceArs: CASH_UNIT_PRICE_ARS,
      filledAt: new Date(),
      eventType: "ACCEPTED",
      reason: null,
      metadata: auditBase,
    }, base);
  });
};