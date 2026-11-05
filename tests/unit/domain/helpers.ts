// Builders de filas tipadas para los tests unitarios del dominio: SIN DB,
// importan sólo los tipos de src/contracts y defaults del seed
// (tests/helpers/fixtures.ts). Dinero entra como STRING y sale como
// FinancialDecimal construido desde string (AGENTS.md: jamás desde number).
//
// El vocabulario está discriminado por side (spec grandes montos, D2/D3):
// BUY/SELL traen `sizeShares` (acciones) y CASH_IN/CASH_OUT traen
// `amountArs` (monto exacto). No hay builder que mezcle las dos unidades.

import { FinancialDecimal } from "../../../src/contracts/index.js";
import type {
  MarketdataSnapshot,
  PositionPnl,
  RestingOrder,
  SettledOrderMovement,
  TradingSide,
} from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENT_PAMP_ID,
  SEED_LATEST_MARKETDATA_DATE,
} from "../../helpers/fixtures.js";

export interface TradingMovementOverrides {
  readonly instrumentId?: number;
  readonly side?: TradingSide;
  readonly sizeShares?: number;
  /** Precio como string (regla de dinero del repo). */
  readonly priceArs?: string;
}

/** Movimiento FILLED de TRADING default: BUY 10 @ "100.00" del PAMP (id 47). */
export const buildTradingMovement = (
  overrides: TradingMovementOverrides = {},
): SettledOrderMovement => {
  const instrumentId = overrides.instrumentId ?? SEED_INSTRUMENT_PAMP_ID;
  const sizeShares = overrides.sizeShares ?? 10;
  const priceArs = new FinancialDecimal(overrides.priceArs ?? "100.00");
  return overrides.side === "SELL"
    ? { instrumentId, sizeShares, priceArs, side: "SELL" }
    : { instrumentId, sizeShares, priceArs, side: "BUY" };
};

export interface CashMovementOverrides {
  readonly side?: "CASH_IN" | "CASH_OUT";
  /** Monto exacto en ARS como string (con centavos). */
  readonly amountArs?: string;
}

/** Movimiento FILLED de CASH default: CASH_IN "100.00" (sin instrumento). */
export const buildCashMovement = (
  overrides: CashMovementOverrides = {},
): SettledOrderMovement => {
  const amountArs = new FinancialDecimal(overrides.amountArs ?? "100.00");
  return overrides.side === "CASH_OUT"
    ? { amountArs, side: "CASH_OUT" }
    : { amountArs, side: "CASH_IN" };
};

export interface RestingOrderOverrides {
  readonly id?: number;
  readonly instrumentId?: number;
  readonly side?: TradingSide;
  readonly sizeShares?: number;
  /** Límite como string. */
  readonly limitPriceArs?: string;
}

/** Orden NEW resting default: BUY 10 @ "100.00" del PAMP (id 47). */
export const buildRestingOrder = (
  overrides: RestingOrderOverrides = {},
): RestingOrder => ({
  id: overrides.id ?? 1,
  instrumentId: overrides.instrumentId ?? SEED_INSTRUMENT_PAMP_ID,
  side: overrides.side ?? "BUY",
  sizeShares: overrides.sizeShares ?? 10,
  limitPriceArs: new FinancialDecimal(overrides.limitPriceArs ?? "100.00"),
});

export interface SnapshotOverrides {
  readonly instrumentId?: number;
  /** YYYY-MM-DD; default: última fecha de marketdata del seed. */
  readonly date?: string;
  readonly closeArs?: string;
  readonly previousCloseArs?: string;
}

/** Snapshot de marketdata default: PAMP, "100.00"/"100.00", 2023-07-14. */
export const buildSnapshot = (
  overrides: SnapshotOverrides = {},
): MarketdataSnapshot => ({
  instrumentId: overrides.instrumentId ?? SEED_INSTRUMENT_PAMP_ID,
  date: overrides.date ?? SEED_LATEST_MARKETDATA_DATE,
  closeArs: new FinancialDecimal(overrides.closeArs ?? "100.00"),
  previousCloseArs: new FinancialDecimal(overrides.previousCloseArs ?? "100.00"),
});

/** Posición de un instrumento, con fail ruidoso si no está (evita el `!`). */
export const positionOfInstrument = (
  positions: readonly PositionPnl[],
  instrumentId: number,
): PositionPnl => {
  const position = positions.find(
    (candidate) => candidate.instrumentId === instrumentId,
  );
  if (position === undefined) {
    throw new Error(
      `se esperaba la posición del instrumento ${instrumentId}, vino: ${positions
        .map((candidate) => candidate.instrumentId)
        .join(", ")}`,
    );
  }
  return position;
};
