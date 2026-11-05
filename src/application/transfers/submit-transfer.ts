// UC-5 — submitTransfer: transferencias de cash.
//
// DECISIONS.md: las transferencias se modelan como ORDERS del instrumento
// MONEDA del cash (ARS — seed id 66, docs/database.md §2) con la convención
// del seed: price = 1.00 (un peso) y size = el MONTO en pesos.
//
// D4 (spec grandes montos): las transferencias NUEVAS mueven el monto EXACTO
// en ARS, con centavos y sin floor — 0.01 es una transferencia válida, no un
// ZERO_SIZE. El monto viaja como Decimal desde el string del borde; el draft
// CASH lleva `amountArs` (nunca acciones) y el evento lo audita como string
// canónico de 2 decimales (metadata.amountArs) para los replays históricos.
// Un CASH_IN/CASH_OUT histórico de 123.45 que persistió 123 sigue moviendo
// 123.00: no se reescribe ni se regalan/debitan centavos.
//
// Espeja submitOrder (UC-3) paso a paso — es el MISMO mecanismo de orders,
// sin instrumento del request ni precio de referencia:
//
//   1. userExists (tx)                       ⇒ 404 USER_NOT_FOUND.
//   2. instrumento del cash por ticker (ARS, dentro de la tx): el seed lo
//      garantiza (docs §2); si faltara es corrupción ⇒ 500 INTERNAL_ERROR.
//   3. CASH_IN (depósito): SIN validación de fondos ⇒ FILLED inmediata.
//      CASH_OUT (extracción): cash DISPONIBLE leído DENTRO de la tx
//      (listSettledMovements + listRestingOrders con tx → deriveCash −
//      deriveReservations.cashReservedArs): monto > disponible ⇒ REJECTED
//      INSUFFICIENT_FUNDS persistida (201) con el evento y metadata
//      (disponible y requerido), conservando el monto pedido exacto.
//   4. createOrder(draft, tx) es la PRIMERA ESCRITURA (claim idempotente
//      con ON CONFLICT DO NOTHING): el draft completo se decide ANTES con
//      las lecturas de 1–3. IDEMPOTENT_REPLAY ⇒ la orden original (201, sin
//      evento nuevo); IDEMPOTENT_CONFLICT ⇒ 409. La persistencia es la
//      COMPARTIDA con el envío de órdenes (persist-order-decision.ts).
//   5. appendOrderEvent ACCEPTED/REJECTED en la MISMA tx (auditoría en la
//      misma transacción que la mutación).

import {
  API_ERROR_CODES,
  FinancialDecimal,
  serializeMoneyArs,
  type ApiErrorCode,
  type InstrumentRecord,
  type OrderEventMetadata,
  type TransactionContext,
  type TransferSide,
} from "../../contracts/index.js";
import { deriveCash, deriveReservations } from "../../domain/index.js";
import type {
  InstrumentRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";
import type { DecidedCashOrder } from "../orders/decide-order.js";
import {
  persistOrderDecision,
  type CashOrderDraftBase,
  type PersistedOrderDecision,
} from "../orders/persist-order-decision.js";

/** Ticker del instrumento MONEDA del cash (seed: ARS, id 66 — fixtures). */
const CASH_TICKER = "ARS";

/** Precio unitario del cash: un peso (convención histórica del seed). */
const CASH_UNIT_PRICE_ARS = new FinancialDecimal("1.00");

/**
 * Error de aplicación de la transferencia: el router lo mapea a status +
 * apiErrorBody. NO hay códigos extra: USER_NOT_FOUND ya vive en
 * API_ERROR_CODES (el 409 de idempotencia es la clase compartida).
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
  /** Monto exacto en ARS (> 0 — PositiveArsInputSchema en el borde). */
  readonly amountArs: FinancialDecimal;
  readonly side: TransferSide;
  /** Idempotency-Key del header; null si no viene (es opcional). */
  readonly idempotencyKey: string | null;
}

/** Salida: la fila persistida + la razón (REJECTED; null si FILLED). */
export type SubmitTransferResult = PersistedOrderDecision;

/**
 * Metadata de auditoría común: el monto va como string canónico de 2
 * decimales (ningún float y ningún Decimal crudo en el jsonb).
 */
const buildAuditBase = (
  instrument: InstrumentRecord,
  amountArs: FinancialDecimal,
): OrderEventMetadata => ({
  ticker: instrument.ticker,
  amountArs: serializeMoneyArs(amountArs),
});

/** Cash que entra o sale: FILLED inmediata a 1.00, moviendo el monto exacto. */
const fillTransfer = (
  amountArs: FinancialDecimal,
  auditBase: OrderEventMetadata,
  decidedAt: Date,
): DecidedCashOrder => ({
  status: "FILLED",
  amountArs,
  filledPriceArs: CASH_UNIT_PRICE_ARS,
  filledAt: decidedAt,
  eventType: "ACCEPTED",
  reason: null,
  metadata: auditBase,
});

/** Datos de la validación de fondos del CASH_OUT, ya leídos en la tx. */
interface CashOutAssessment {
  readonly amountArs: FinancialDecimal;
  readonly cashAvailableArs: FinancialDecimal;
  readonly auditBase: OrderEventMetadata;
  /** Instante de decisión (después de las lecturas de fondos). */
  readonly decidedAt: Date;
}

/**
 * CASH_OUT: el monto EXACTO contra el DISPONIBLE (settled − reservas). No
 * alcanza ⇒ REJECTED persistida (201) con el evento, el monto pedido como
 * size y la metadata del porqué (sin redondear ni anular el monto).
 */
const assessCashOut = (input: CashOutAssessment): DecidedCashOrder => {
  if (!input.amountArs.greaterThan(input.cashAvailableArs)) {
    return fillTransfer(input.amountArs, input.auditBase, input.decidedAt);
  }
  return {
    status: "REJECTED",
    amountArs: input.amountArs,
    filledPriceArs: null,
    filledAt: null,
    eventType: "REJECTED",
    reason: "INSUFFICIENT_FUNDS",
    metadata: {
      ...input.auditBase,
      requiredArs: serializeMoneyArs(input.amountArs),
      cashAvailableArs: serializeMoneyArs(input.cashAvailableArs),
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
 * Campos comunes del draft de CASH (el status/fill se decide después). El
 * `side` se ramifica para conservar el literal discriminado del contrato.
 */
const buildDraftBase = ({
  input,
  instrumentId,
  datetime,
}: DraftBaseInput): CashOrderDraftBase => {
  const common = {
    userId: input.userId,
    instrumentId,
    type: "MARKET" as const,
    timeInForce: "GTC" as const,
    priceArs: CASH_UNIT_PRICE_ARS,
    idempotencyKey: input.idempotencyKey,
    datetime,
  };
  return input.side === "CASH_IN"
    ? { ...common, side: "CASH_IN" }
    : { ...common, side: "CASH_OUT" };
};

interface DecideTransferContext {
  readonly deps: SubmitTransferDeps;
  readonly tx: TransactionContext;
  readonly userId: number;
  readonly amountArs: FinancialDecimal;
  readonly side: TransferSide;
  readonly auditBase: OrderEventMetadata;
}

/**
 * Fondos DENTRO de la tx (validez de la validación): disponible = settled −
 * reservas (deriveCash sobre los movimientos FILLED menos deriveReservations
 * sobre las NEW).
 */
const readCashAvailable = async (
  context: DecideTransferContext,
): Promise<FinancialDecimal> => {
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
 * Decide el estado: CASH_IN se resuelve sin leer fondos; sólo CASH_OUT lee
 * movimientos y reservas. No hay rama ZERO_SIZE: un monto positivo, por
 * chico que sea, es una transferencia válida (D4).
 */
const decideTransfer = async (
  context: DecideTransferContext,
): Promise<DecidedCashOrder> => {
  if (context.side === "CASH_IN") {
    return fillTransfer(context.amountArs, context.auditBase, new Date());
  }

  const cashAvailableArs = await readCashAvailable(context);
  return assessCashOut({
    amountArs: context.amountArs,
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

  const datetime = new Date(); // hora de envío/aceptación
  const base = buildDraftBase({
    input,
    instrumentId: cashInstrument.id,
    datetime,
  });
  const auditBase = buildAuditBase(cashInstrument, amountArs);

  const decided = await decideTransfer({
    deps,
    tx,
    userId,
    amountArs,
    side,
    auditBase,
  });

  return persistOrderDecision(deps.orders, tx, {
    kind: "CASH",
    base,
    decided,
  });
};

export const submitTransfer = (
  deps: SubmitTransferDeps,
  input: SubmitTransferInput,
): Promise<SubmitTransferResult> =>
  deps.orders.withUserTransaction(input.userId, (tx) =>
    submitInsideTransaction(deps, tx, input),
  );
