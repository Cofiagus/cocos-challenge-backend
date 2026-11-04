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
//      garantiza (docs §2); si faltara es corrupción ⇒ 500 INTERNAL_ERROR (manejador central).
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
//      409 (B ya comparó el payload). La persistencia es la COMPARTIDA con
//      el envío de órdenes (persist-order-decision.ts).
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
  type InstrumentRecord,
  type OrderEventMetadata,
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
import { rejectForZeroSize, type DecidedOrder } from "../orders/decide-order.js";
import {
  persistOrderDecision,
  type OrderDraftBase,
  type PersistedOrderDecision,
} from "../orders/persist-order-decision.js";

/** Ticker del instrumento MONEDA del cash (seed: ARS, id 66 — fixtures). */
const CASH_TICKER = "ARS";

/** Precio unitario del cash: un peso (convención del seed: size = pesos). */
const CASH_UNIT_PRICE_ARS = new Decimal("1.00");

/**
 * Error de aplicación de la transferencia: el router lo mapea a status +
 * apiErrorBody. A diferencia de E, NO hay códigos extra: USER_NOT_FOUND ya
 * vive en API_ERROR_CODES (el 409 de idempotencia es la clase compartida).
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
export type SubmitTransferResult = PersistedOrderDecision;

/** Tamaño decidido: pesos enteros + el residuo que queda como cash. */
interface TransferSizing {
  readonly sizeShares: number;
  readonly residualArs: Decimal;
}

/**
 * size en pesos con la MISMA regla de sizing de DECISIONS.md:
 * floor(amountArs / 1.00) — con price 1.00 es el monto pedido en pesos
 * enteros (la fracción de peso no persiste en `size` INT; queda como
 * residuo documentado en la metadata del evento).
 */
const sizeTransfer = (amountArs: Decimal): TransferSizing => {
  const sizeShares = sizeSharesFromAmountArs(amountArs, CASH_UNIT_PRICE_ARS);
  const residualArs = amountArs.minus(
    new Decimal(String(sizeShares)).mul(CASH_UNIT_PRICE_ARS),
  );
  return { sizeShares, residualArs };
};

/** Metadata de auditoría común (dinero como string de 2 decimales). */
const buildAuditBase = (
  instrument: InstrumentRecord,
  amountArs: Decimal,
  residualArs: Decimal,
): OrderEventMetadata => ({
  ticker: instrument.ticker,
  amountArs: amountArs.toFixed(2),
  residualArs: residualArs.toFixed(2),
});

/**
 * Cash que entra o sale: FILLED inmediata a 1.00 (convención del seed; el
 * disponible sube o baja exactamente el monto).
 */
const fillTransfer = (
  sizeShares: number,
  auditBase: OrderEventMetadata,
  decidedAt: Date,
): DecidedOrder => ({
  status: "FILLED",
  sizeShares,
  filledPriceArs: CASH_UNIT_PRICE_ARS,
  filledAt: decidedAt,
  eventType: "ACCEPTED",
  reason: null,
  metadata: auditBase,
});

/** Datos de la validación de fondos del CASH_OUT, ya leídos en la tx. */
interface CashOutAssessment {
  readonly sizeShares: number;
  readonly cashAvailableArs: Decimal;
  readonly auditBase: OrderEventMetadata;
  /** Instante de decisión (después de las lecturas de fondos). */
  readonly decidedAt: Date;
}

/**
 * CASH_OUT: el monto pedido contra el DISPONIBLE (settled − reservas). No
 * alcanza ⇒ REJECTED persistida (201) con el evento y la metadata del porqué.
 */
const assessCashOut = (input: CashOutAssessment): DecidedOrder => {
  const requiredArs = new Decimal(String(input.sizeShares)).mul(
    CASH_UNIT_PRICE_ARS,
  );
  if (!requiredArs.greaterThan(input.cashAvailableArs)) {
    return fillTransfer(input.sizeShares, input.auditBase, input.decidedAt);
  }
  return {
    status: "REJECTED",
    sizeShares: input.sizeShares, // el monto pedido (no 0: no hubo floor que lo anule)
    filledPriceArs: null,
    filledAt: null,
    eventType: "REJECTED",
    reason: "INSUFFICIENT_FUNDS",
    metadata: {
      ...input.auditBase,
      requiredArs: requiredArs.toFixed(2),
      cashAvailableArs: input.cashAvailableArs.toFixed(2),
    },
  };
};

/** 404 de usuario (lectura en la tx: el lock ya está tomado). */
const requireExistingUser = async (
  deps: SubmitTransferDeps,
  tx: TransactionContext,
  userId: number,
): Promise<void> => {
  const userExists = await deps.portfolioRead.userExists(userId, tx);
  if (!userExists) {
    throw new SubmitTransferError(
      404,
      API_ERROR_CODES.USER_NOT_FOUND,
      `No existe el usuario ${String(userId)}.`,
    );
  }
};

/**
 * Instrumento del cash: la MONEDA ARS del seed (ticker exacto). El seed la
 * garantiza (docs/database.md §2): no encontrarla es corrupción de datos ⇒
 * error no controlado (500 INTERNAL_ERROR del manejador central).
 */
const requireCashInstrument = async (
  deps: SubmitTransferDeps,
  tx: TransactionContext,
): Promise<InstrumentRecord> => {
  const cashInstrument = await deps.instruments.findByTicker(CASH_TICKER, tx);
  if (cashInstrument === null) {
    throw new Error(
      `No existe el instrumento del cash (ticker ${CASH_TICKER}): seed corrupto.`,
    );
  }
  return cashInstrument;
};

interface DraftBaseInput {
  readonly input: SubmitTransferInput;
  readonly instrumentId: number;
  readonly datetime: Date;
}

/**
 * Campos comunes del draft (el status/fill se decide y agrega después).
 * type MARKET + tif GTC: convención del seed para las filas CASH (no hay
 * ni límite ni referencia — el "precio de mercado" del cash es 1.00).
 */
const buildDraftBase = ({
  input,
  instrumentId,
  datetime,
}: DraftBaseInput): OrderDraftBase => ({
  userId: input.userId,
  instrumentId,
  side: input.side,
  type: "MARKET",
  timeInForce: "GTC",
  priceArs: CASH_UNIT_PRICE_ARS,
  idempotencyKey: input.idempotencyKey,
  datetime,
});

interface DecideTransferContext {
  readonly deps: SubmitTransferDeps;
  readonly tx: TransactionContext;
  readonly userId: number;
  readonly side: TransferSide;
  readonly sizing: TransferSizing;
  readonly auditBase: OrderEventMetadata;
}

/**
 * Fondos DENTRO de la tx (validez de la validación): disponible = settled −
 * reservas (deriveCash sobre los movimientos FILLED menos deriveReservations
 * sobre las NEW).
 */
const readCashAvailable = async (
  context: DecideTransferContext,
): Promise<Decimal> => {
  // Awaits SECUENCIALES: Prisma no documenta queries paralelas dentro de una
  // $transaction interactiva, y dos SELECT no ganan nada medible.
  const movements = await context.deps.portfolioRead.listSettledMovements(
    context.userId,
    context.tx,
  );
  const restingOrders = await context.deps.portfolioRead.listRestingOrders(
    context.userId,
    context.tx,
  );
  return deriveCash(movements).minus(
    deriveReservations(restingOrders).cashReservedArs,
  );
};

/**
 * Decide el estado: ZERO_SIZE y CASH_IN se resuelven sin leer fondos; sólo
 * CASH_OUT con size > 0 lee movimientos y reservas.
 */
const decideTransfer = async (
  context: DecideTransferContext,
): Promise<DecidedOrder> => {
  const { sizeShares } = context.sizing;
  if (sizeShares === 0) return rejectForZeroSize(context.auditBase);
  if (context.side === "CASH_IN") {
    return fillTransfer(sizeShares, context.auditBase, new Date());
  }

  const cashAvailableArs = await readCashAvailable(context);
  return assessCashOut({
    sizeShares,
    cashAvailableArs,
    auditBase: context.auditBase,
    // Segundo instante: el fill se fecha al DECIDIR, no al recibir el envío.
    decidedAt: new Date(),
  });
};

/** Todo lo de la transferencia corre con el lock por usuario ya tomado. */
const submitInsideTransaction = async (
  deps: SubmitTransferDeps,
  tx: TransactionContext,
  input: SubmitTransferInput,
): Promise<SubmitTransferResult> => {
  const { userId, amountArs, side } = input;

  await requireExistingUser(deps, tx, userId);
  const cashInstrument = await requireCashInstrument(deps, tx);

  const sizing = sizeTransfer(amountArs);
  const datetime = new Date(); // hora de envío/aceptación
  const base = buildDraftBase({
    input,
    instrumentId: cashInstrument.id,
    datetime,
  });
  const auditBase = buildAuditBase(
    cashInstrument,
    amountArs,
    sizing.residualArs,
  );

  const decided = await decideTransfer({
    deps,
    tx,
    userId,
    side,
    sizing,
    auditBase,
  });

  return persistOrderDecision(deps.orders, tx, decided, base);
};

export const submitTransfer = (
  deps: SubmitTransferDeps,
  input: SubmitTransferInput,
): Promise<SubmitTransferResult> =>
  deps.orders.withUserTransaction(input.userId, (tx) =>
    submitInsideTransaction(deps, tx, input),
  );
