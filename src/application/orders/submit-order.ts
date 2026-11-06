// UC-3 — submitOrder: coordina el envío dentro de UNA transacción con lock
// por usuario (withUserTransaction — DECISIONS.md).
//
// Orden que hace válida la concurrencia y la idempotencia:
//   1. userExists (tx)                       ⇒ 404 USER_NOT_FOUND.
//   2. instrumento por instrumentId|ticker   ⇒ 404 / MONEDA ⇒ 400 SIN orden.
//   3. precio de referencia (getLatestSnapshot, dentro de la tx) sólo si la
//      decisión lo necesita: MARKET y LIMIT IOC/FOK; LIMIT GTC NO (matriz
//      caso 7: NEW sin precio). Sin precio ⇒ REJECTED NO_PRICE persistida.
//   4. lecturas de fondos/tenencia dentro de la tx, después de los rechazos
//      que no las necesitan (NO_PRICE, ZERO_SIZE).
//   5. createOrder(draft, tx) es la PRIMERA ESCRITURA (claim idempotente con
//      ON CONFLICT DO NOTHING — B): el draft completo, status incluido, se
//      decide ANTES con las lecturas de 3–4 (las lecturas no son escrituras).
//      IDEMPOTENT_REPLAY ⇒ la orden original (201, sin evento);
//      IDEMPOTENT_CONFLICT ⇒ 409 (B ya comparó el payload).
//   6. appendOrderEvent ACCEPTED/REJECTED/CANCELLED en la MISMA tx, sólo si
//      el claim CREÓ la orden.
//
// La respuesta (router) es 201 OrderResponse SIEMPRE que se persistió
// (FILLED/NEW/REJECTED/CANCELLED — DECISIONS.md). Dinero SIEMPRE Decimal
// (AGENTS.md); la decisión pura vive en decide-order.ts.

import {
  API_ERROR_CODES,
  MAX_ORDER_SIZE_SHARES,
  type ApiErrorCode,
  type CreateOrderRequest,
  type FinancialDecimal,
  type InstrumentRecord,
  type TransactionContext,
} from "../../contracts/index.js";
import { deriveReservations } from "../../domain/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";
import {
  assessFunds,
  buildAuditBase,
  decideAcceptedOrder,
  limitPriceOf,
  needsReferencePrice,
  rejectForMissingPrice,
  rejectForZeroSize,
  resolveSizing,
  type DecidedOrder,
  type SizingDecision,
} from "./decide-order.js";
import {
  persistOrderDecision,
  type TradingOrderDraftBase,
  type PersistedOrderDecision,
} from "./persist-order-decision.js";
// F2-IDEM: la huella canónica del request vive en el borde (pura, sin
// Express); application la aplica antes de derivar el `size`.
import { requestFingerprintOf } from "../../http/shared/edge.js";

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
export type SubmitOrderResult = PersistedOrderDecision;

/** 404 de usuario (lectura en la tx: el lock ya está tomado). */
const requireExistingUser = async (
  deps: SubmitOrderDeps,
  tx: TransactionContext,
  userId: number,
): Promise<void> => {
  const userExists = await deps.portfolioRead.userExists(userId, tx);
  if (!userExists) {
    throw new SubmitOrderError(
      404,
      API_ERROR_CODES.USER_NOT_FOUND,
      `No existe el usuario ${String(userId)}.`,
    );
  }
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

/** Referencia humana del instrumento pedido, para el 404. */
const instrumentReferenceOf = (request: CreateOrderRequest): string =>
  request.instrumentId !== undefined
    ? `instrumentId ${String(request.instrumentId)}`
    : `ticker ${String(request.ticker)}`;

/** Inexistente ⇒ 404; MONEDA ⇒ 400 SIN orden. */
const requireOperableInstrument = (
  instrument: InstrumentRecord | null,
  request: CreateOrderRequest,
): InstrumentRecord => {
  if (instrument === null) {
    throw new SubmitOrderError(
      404,
      API_ERROR_CODES.INSTRUMENT_NOT_FOUND,
      `No existe el instrumento (${instrumentReferenceOf(request)}).`,
    );
  }
  if (instrument.type === "MONEDA") {
    throw new SubmitOrderError(
      400,
      API_ERROR_CODES.INSTRUMENT_NOT_OPERABLE,
      `${instrument.ticker} es MONEDA: no operable (DECISIONS.md).`,
    );
  }
  return instrument;
};

/** Precio de referencia DENTRO de la tx, sólo si la decisión lo necesita. */
const readReferencePrice = async (
  deps: SubmitOrderDeps,
  instrument: InstrumentRecord,
  tx: TransactionContext,
  needsPrice: boolean,
): Promise<FinancialDecimal | null> => {
  if (!needsPrice) return null;
  const snapshot = await deps.marketdata.getLatestSnapshot(instrument.id, tx);
  return snapshot === null ? null : snapshot.closeArs;
};

interface DraftBaseInput {
  readonly input: SubmitOrderInput;
  readonly instrumentId: number;
  readonly limitPriceArs: FinancialDecimal | null;
  readonly datetime: Date;
}

/**
 * Campos del draft de TRADING que no dependen de la decisión de estado. El
 * `side` se ramifica para conservar el literal (la unión discriminada del
 * contrato no acepta un `TradingSide` genérico).
 */
const buildDraftBase = ({
  input,
  instrumentId,
  limitPriceArs,
  datetime,
}: DraftBaseInput): TradingOrderDraftBase => {
  const common = {
    userId: input.userId,
    instrumentId,
    type: input.request.type,
    timeInForce: input.request.timeInForce,
    priceArs: limitPriceArs,
    idempotencyKey: input.idempotencyKey,
    datetime,
    // F2-IDEM: huella del REQUEST original (amountArs incluido, no el size
    // derivado) con el instrumento YA resuelto. Se calcula acá, antes de
    // `decideOrder`/`resolveSizing`, que es donde el monto se pierde.
    requestFingerprint: requestFingerprintOf(input.request, instrumentId),
  };
  return input.request.side === "BUY"
    ? { ...common, side: "BUY" }
    : { ...common, side: "SELL" };
};

interface DecideOrderContext {
  readonly deps: SubmitOrderDeps;
  readonly tx: TransactionContext;
  readonly userId: number;
  readonly request: CreateOrderRequest;
  readonly instrument: InstrumentRecord;
  readonly referencePriceArs: FinancialDecimal | null;
  readonly needsPrice: boolean;
  readonly limitPriceArs: FinancialDecimal | null;
}

/**
 * Un size derivado fuera de INT4 es un error de CONTRATO, no un REJECTED de
 * negocio: 400 VALIDATION_ERROR y ninguna escritura (ni orden REJECTED). Sólo
 * se traduce el RangeError del sizing; un error inesperado sigue subiendo al
 * manejador central (500).
 */
const resolveSizingOrThrow = (
  request: CreateOrderRequest,
  referencePriceArs: FinancialDecimal | null,
  limitPriceArs: FinancialDecimal | null,
): SizingDecision => {
  try {
    return resolveSizing(request, referencePriceArs, limitPriceArs);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new SubmitOrderError(
        400,
        API_ERROR_CODES.VALIDATION_ERROR,
        `El size derivado de amountArs no es un entero entre 0 y ${String(MAX_ORDER_SIZE_SHARES)}.`,
      );
    }
    throw error;
  }
};

/**
 * Decide el estado leyendo fondos/tenencia en la tx, en el orden que evita
 * lecturas innecesarias: NO_PRICE y ZERO_SIZE se resuelven antes.
 */
const decideOrder = async (
  context: DecideOrderContext,
): Promise<DecidedOrder> => {
  const { request, instrument, referencePriceArs, limitPriceArs } = context;
  if (referencePriceArs === null && context.needsPrice) {
    return rejectForMissingPrice(request, instrument);
  }

  const sizing = resolveSizingOrThrow(
    request,
    referencePriceArs,
    limitPriceArs,
  );
  const auditBase = buildAuditBase(
    instrument,
    request,
    referencePriceArs,
    sizing,
  );
  if (sizing.sizeShares === 0) {
    return rejectForZeroSize(auditBase);
  }

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
  const rejected = assessFunds({
    request,
    instrumentId: instrument.id,
    sizeShares: sizing.sizeShares,
    referencePriceArs,
    limitPriceArs,
    movements,
    reservations: deriveReservations(restingOrders),
    auditBase,
  });
  if (rejected !== null) return rejected;

  return decideAcceptedOrder({
    request,
    sizeShares: sizing.sizeShares,
    referencePriceArs,
    limitPriceArs,
    auditBase,
    // Segundo instante: el fill se fecha al DECIDIR, no al recibir el envío.
    decidedAt: new Date(),
  });
};

/** Todo lo del envío corre con el lock por usuario ya tomado. */
const submitInsideTransaction = async (
  deps: SubmitOrderDeps,
  tx: TransactionContext,
  input: SubmitOrderInput,
): Promise<SubmitOrderResult> => {
  const { userId, request } = input;

  await requireExistingUser(deps, tx, userId);
  const instrument = requireOperableInstrument(
    await resolveInstrument(deps, request, tx),
    request,
  );

  const needsPrice = needsReferencePrice(request);
  const referencePriceArs = await readReferencePrice(
    deps,
    instrument,
    tx,
    needsPrice,
  );
  const datetime = new Date(); // hora de envío/aceptación
  const limitPriceArs = limitPriceOf(request);
  const base = buildDraftBase({
    input,
    instrumentId: instrument.id,
    limitPriceArs,
    datetime,
  });

  const decided = await decideOrder({
    deps,
    tx,
    userId,
    request,
    instrument,
    referencePriceArs,
    needsPrice,
    limitPriceArs,
  });

  return persistOrderDecision(deps.orders, tx, {
    kind: "TRADING",
    base,
    decided,
  });
};

export const submitOrder = (
  deps: SubmitOrderDeps,
  input: SubmitOrderInput,
): Promise<SubmitOrderResult> =>
  deps.orders.withUserTransaction(input.userId, (tx) =>
    submitInsideTransaction(deps, tx, input),
  );
