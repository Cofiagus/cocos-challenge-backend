// Builders de filas tipadas para los tests unitarios del dominio: SIN DB,
// importan sólo los tipos de src/contracts y defaults del seed
// (tests/helpers/fixtures.ts). Dinero entra como STRING y sale como
// Decimal construido desde string (AGENTS.md: jamás desde number).

import { Decimal } from "decimal.js";
import type {
  MarketdataSnapshot,
  OrderSide,
  PositionPnl,
  RestingOrder,
  SettledOrderMovement,
  TradingSide,
} from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENT_PAMP_ID,
  SEED_LATEST_MARKETDATA_DATE,
} from "../../helpers/fixtures.js";

export interface MovementOverrides {
  readonly instrumentId?: number;
  readonly side?: OrderSide;
  readonly sizeShares?: number;
  /** Precio como string (regla de dinero del repo). */
  readonly priceArs?: string;
}

/** Movimiento FILLED default: BUY 10 @ "100.00" del PAMP del seed (id 47). */
export const buildMovement = (
  overrides: MovementOverrides = {},
): SettledOrderMovement => ({
  instrumentId: overrides.instrumentId ?? SEED_INSTRUMENT_PAMP_ID,
  side: overrides.side ?? "BUY",
  sizeShares: overrides.sizeShares ?? 10,
  priceArs: new Decimal(overrides.priceArs ?? "100.00"),
});

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
  limitPriceArs: new Decimal(overrides.limitPriceArs ?? "100.00"),
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
  closeArs: new Decimal(overrides.closeArs ?? "100.00"),
  previousCloseArs: new Decimal(overrides.previousCloseArs ?? "100.00"),
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