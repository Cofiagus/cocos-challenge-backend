// Soporte compartido de los tests de integración de infra (célula LM-D).
// SOLO para tests: builders de drafts discriminados (D2) + helpers de
// narrowing de los resultados (jest no estrecha tras expect(...)).
//
// Requisito de la suite: `npm run test:db:reset` antes de `npm test`
// (recrea cocos_challenge_test desde migración versionada + seed).

import { randomUUID } from "node:crypto";
import type {
  CashOrderDraft,
  CashOrderRecord,
  CreateOrderResult,
  OrderRecord,
  TradingOrderDraft,
  TradingOrderRecord,
  TradingSide,
  TransferSide,
} from "../../../src/contracts/index.js";
import { FinancialDecimal as Decimal } from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENT_ARS_ID,
  SEED_INSTRUMENT_PAMP_ID,
} from "../../helpers/fixtures.js";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Overrides de un draft de TRADING (acciones enteras). */
export interface TradingDraftOverrides {
  readonly instrumentId?: number;
  readonly side?: TradingSide;
  readonly type?: TradingOrderDraft["type"];
  readonly timeInForce?: TradingOrderDraft["timeInForce"];
  readonly status?: TradingOrderDraft["status"];
  readonly sizeShares?: number;
  readonly priceArs?: Decimal | null;
  readonly filledPriceArs?: Decimal | null;
  readonly filledAt?: Date | null;
  readonly idempotencyKey?: string | null;
  readonly datetime?: Date;
  /** Huella canónica del request ORIGINAL (F2-IDEM); ausente = draft sin huella. */
  readonly requestFingerprint?: string;
}

// `fallback` NO participa de la inferencia: sin `NoInfer`, T se infería de
// AMBOS argumentos, así que un `new Decimal(...)` global como default (o como
// override) arrastraba T al `Decimal` de 20 cifras —es supertipo estructural de
// la marca— y el argumento se aceptaba sin marca; el error recién aparecía una
// capa más arriba, al asignar el resultado a un campo `FinancialDecimal`, o
// desaparecía si el resultado no aterrizaba en uno. Con NoInfer el diagnóstico
// cae en el argumento culpable, que es lo que se quiere al migrar fixtures.
const valueOr = <T>(value: T | undefined, fallback: NoInfer<T>): T =>
  value === undefined ? fallback : value;

const uuidOr = (value: string | null | undefined): string | null =>
  value === undefined ? randomUUID() : value;

/**
 * Draft default de TRADING: LIMIT BUY NEW GTC, 10 acciones @ 930.00 (precio
 * del seed de PAMP), key aleatoria — el payload "vanilla" del envío.
 */
export const buildDraft = (
  userId: number,
  overrides: TradingDraftOverrides = {},
): TradingOrderDraft => ({
  userId,
  instrumentId: valueOr(overrides.instrumentId, SEED_INSTRUMENT_PAMP_ID),
  side: valueOr(overrides.side, "BUY"),
  type: valueOr(overrides.type, "LIMIT"),
  timeInForce: valueOr(overrides.timeInForce, "GTC"),
  status: valueOr(overrides.status, "NEW"),
  sizeShares: valueOr(overrides.sizeShares, 10),
  priceArs: valueOr(overrides.priceArs, new Decimal("930.00")),
  filledPriceArs: valueOr(overrides.filledPriceArs, null),
  filledAt: valueOr(overrides.filledAt, null),
  idempotencyKey: uuidOr(overrides.idempotencyKey),
  datetime: valueOr(overrides.datetime, new Date()),
  // `?: string` con exactOptionalPropertyTypes: sólo se agrega si vino.
  ...(overrides.requestFingerprint === undefined
    ? {}
    : { requestFingerprint: overrides.requestFingerprint }),
});

/** Overrides de un draft de CASH (monto ARS exacto, precio unitario 1.00). */
export interface CashDraftOverrides {
  readonly instrumentId?: number;
  readonly side?: TransferSide;
  readonly type?: CashOrderDraft["type"];
  readonly timeInForce?: CashOrderDraft["timeInForce"];
  readonly status?: CashOrderDraft["status"];
  readonly amountArs?: Decimal;
  readonly priceArs?: Decimal | null;
  readonly filledPriceArs?: Decimal | null;
  readonly filledAt?: Date | null;
  readonly idempotencyKey?: string | null;
  readonly datetime?: Date;
  /** Huella del pedido cash (R-02); ausente = draft sin huella (histórico). */
  readonly requestFingerprint?: string;
}

/**
 * Draft default de CASH: CASH_IN FILLED, monto exacto y precio unitario
 * histórico 1.00 (instrumento ARS del seed).
 */
export const buildCashDraft = (
  userId: number,
  overrides: CashDraftOverrides = {},
): CashOrderDraft => ({
  userId,
  instrumentId: valueOr(overrides.instrumentId, SEED_INSTRUMENT_ARS_ID),
  side: valueOr(overrides.side, "CASH_IN"),
  type: valueOr(overrides.type, "MARKET"),
  timeInForce: valueOr(overrides.timeInForce, "GTC"),
  status: valueOr(overrides.status, "FILLED"),
  amountArs: valueOr(overrides.amountArs, new Decimal("123.45")),
  priceArs: valueOr(overrides.priceArs, new Decimal("1.00")),
  filledPriceArs: valueOr(overrides.filledPriceArs, new Decimal("1.00")),
  filledAt: valueOr(overrides.filledAt, null),
  idempotencyKey: uuidOr(overrides.idempotencyKey),
  datetime: valueOr(overrides.datetime, new Date()),
  // `?: string` con exactOptionalPropertyTypes: sólo se agrega si vino.
  ...(overrides.requestFingerprint === undefined
    ? {}
    : { requestFingerprint: overrides.requestFingerprint }),
});

export const expectCreated = (result: CreateOrderResult): OrderRecord => {
  if (result.outcome !== "CREATED") {
    throw new Error(`esperaba CREATED, llegó ${result.outcome}`);
  }
  return result.order;
};

export const expectReplay = (result: CreateOrderResult): OrderRecord => {
  if (result.outcome !== "IDEMPOTENT_REPLAY") {
    throw new Error(`esperaba IDEMPOTENT_REPLAY, llegó ${result.outcome}`);
  }
  return result.order;
};

export const expectConflict = (result: CreateOrderResult): OrderRecord => {
  if (result.outcome !== "IDEMPOTENT_CONFLICT") {
    throw new Error(`esperaba IDEMPOTENT_CONFLICT, llegó ${result.outcome}`);
  }
  return result.order;
};

/** Narrowing de un OrderRecord de trading (sizeShares sólo existe ahí). */
export const expectTradingRecord = (order: OrderRecord): TradingOrderRecord => {
  if (order.side !== "BUY" && order.side !== "SELL") {
    throw new Error(`esperaba una orden de trading, llegó ${order.side}`);
  }
  return order;
};

/** Narrowing de un OrderRecord de cash (amountArs sólo existe ahí). */
export const expectCashRecord = (order: OrderRecord): CashOrderRecord => {
  if (order.side !== "CASH_IN" && order.side !== "CASH_OUT") {
    throw new Error(`esperaba una orden de cash, llegó ${order.side}`);
  }
  return order;
};
