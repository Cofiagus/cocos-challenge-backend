// Mappers Prisma ↔ contracts.
//
// Filas de PG (tipos del cliente generado) ↔ registros de src/contracts.
// Dinero: Prisma.Decimal → constructor financiero POR STRING
// (value.toString()), jamás por float; a la inversa, string para los
// parámetros de escritura (Prisma parsea el string).
//
// D2/D3 (spec grandes montos): la columna física `size` tiene DOS unidades.
// BUY/SELL se convierten a `number` SÓLO después de verificar finitud, entero
// y rango INT4; CASH_IN/CASH_OUT conservan el monto exacto en
// `FinancialDecimal` (nunca pasan por Number). El precio de ejecución sigue
// leyéndose `filledPrice ?? price` para las dos eras del dataset.
//
// Campos NULL inesperados = corrupción: fallo ruidoso con CorruptRowError,
// nunca normalización en silencio.

import { Prisma, type Instrument, type Order, type OrderEvent } from "@prisma/client";
import {
  FinancialDecimal,
  MAX_ORDER_SIZE_SHARES,
  type InstrumentRecord,
  type InstrumentType,
  type MarketdataSnapshot,
  type OrderEventMetadata,
  type OrderEventRecord,
  type OrderRecord,
  type OrderStatus,
  type RestingOrder,
  type SettledOrderMovement,
  type TradingSide,
} from "../../contracts/index.js";
import { CorruptRowError } from "./corrupt-row.error.js";

/** Prisma.Decimal → constructor financiero, por toString() (nunca float). */
export const decimalFromDb = (value: Prisma.Decimal): FinancialDecimal =>
  new FinancialDecimal(value.toString());

/** decimal.js → string para parámetros de escritura (Prisma parsea). */
export const decimalToDbParam = (value: FinancialDecimal): string =>
  value.toString();

const requiredField = <T>(value: T | null, row: string, field: string): T => {
  if (value === null) {
    throw new CorruptRowError(row, field);
  }
  return value;
};

/** type de instruments es VARCHAR(10) en DB: se estrecha al enum del contrato. */
const toInstrumentType = (value: string): InstrumentType => {
  if (value !== "ACCIONES" && value !== "MONEDA") {
    throw new CorruptRowError("instruments", `type=${value} (valor fuera del contrato)`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// size: dos unidades físicas (D2)
// ---------------------------------------------------------------------------

/**
 * Acciones de BUY/SELL: entero 0..INT4. `Number` sólo DESPUÉS de validar
 * finitud, integralidad y rango (el CHECK de DB es la red, no la excusa).
 * Un 0 fuera de REJECTED es corrupción: sólo el ZERO_SIZE histórico lo admite.
 */
const sharesFromDb = (
  value: Prisma.Decimal | null,
  status: OrderStatus,
  rowLabel: string,
): number | null => {
  if (value === null) {
    return null;
  }
  const shares = decimalFromDb(value);
  if (
    !shares.isFinite() ||
    !shares.isInteger() ||
    shares.isNegative() ||
    shares.greaterThan(MAX_ORDER_SIZE_SHARES)
  ) {
    throw new CorruptRowError(rowLabel, `size=${shares.toString()} (acciones no enteras/INT4)`);
  }
  if (shares.isZero() && status !== "REJECTED") {
    throw new CorruptRowError(rowLabel, `size=0 con status=${status} (sólo REJECTED)`);
  }
  // Seguro por las guardas de arriba: 0..2^31-1.
  return shares.toNumber();
};

/** Monto cash: Decimal exacto (nunca Number). 0 sólo en el REJECTED histórico. */
const cashAmountFromDb = (
  size: Prisma.Decimal | null,
  status: OrderStatus,
  rowLabel: string,
): FinancialDecimal => {
  const amount = decimalFromDb(requiredField(size, rowLabel, "size (monto ARS)"));
  if (!amount.isFinite() || amount.isNegative()) {
    throw new CorruptRowError(rowLabel, `size=${amount.toString()} (monto ARS inválido)`);
  }
  if (amount.isZero() && status !== "REJECTED") {
    throw new CorruptRowError(rowLabel, `size=0 con status=${status} (sólo REJECTED)`);
  }
  return amount;
};

/**
 * Un movimiento cash sólo es comparable como pesos si conserva el precio
 * unitario histórico 1.00. Un precio NULL u otro valor mezclaría unidades:
 * se falla ruidosamente en vez de asumir 1.00.
 */
const requireCashUnitPrice = (price: Prisma.Decimal | null, rowLabel: string): void => {
  const unitPrice = decimalFromDb(requiredField(price, rowLabel, "price (unidad cash 1.00)"));
  if (!unitPrice.equals(1)) {
    throw new CorruptRowError(rowLabel, `price=${unitPrice.toString()} (unidad cash incompatible)`);
  }
};

/** Precio de ejecución de una FILLED: filledPrice (API) ?? price (dataset). */
const executionPriceFromDb = (row: Order, rowLabel: string): FinancialDecimal =>
  decimalFromDb(
    requiredField(row.filledPrice ?? row.price, rowLabel, "filledPrice|price"),
  );

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

/** Campos comunes de una fila de orders (sin la unidad de `size`). */
const orderRowCommon = (row: Order, rowLabel: string) => ({
  id: row.id,
  instrumentId: requiredField(row.instrumentId, rowLabel, "instrumentid"),
  userId: requiredField(row.userId, rowLabel, "userid"),
  type: requiredField(row.type, rowLabel, "type"),
  timeInForce: requiredField(row.timeInForce, rowLabel, "timeInForce"),
  status: requiredField(row.status, rowLabel, "status"),
  // Nullable en DB y en contrato (MARKET sin límite, orden no ejecutada).
  priceArs: row.price === null ? null : decimalFromDb(row.price),
  filledPriceArs: row.filledPrice === null ? null : decimalFromDb(row.filledPrice),
  filledAt: row.filledAt,
  idempotencyKey: row.idempotencyKey,
  datetime: requiredField(row.datetime, rowLabel, "datetime"),
});

export const mapOrderRow = (row: Order): OrderRecord => {
  const side = requiredField(row.side, "orders", "side");
  const common = orderRowCommon(row, "orders");
  if (side === "BUY" || side === "SELL") {
    return {
      ...common,
      side,
      sizeShares: sharesFromDb(row.size, common.status, "orders"),
    };
  }
  return {
    ...common,
    side,
    amountArs: cashAmountFromDb(row.size, common.status, "orders"),
  };
};

/** Proyección FILLED de orders (movió cash/acciones), discriminada por side. */
export const mapSettledMovementRow = (row: Order): SettledOrderMovement => {
  const label = "orders(FILLED)";
  const side = requiredField(row.side, label, "side");
  const status = requiredField(row.status, label, "status");
  if (side === "BUY" || side === "SELL") {
    return {
      side,
      instrumentId: requiredField(row.instrumentId, label, "instrumentid"),
      sizeShares: requiredField(
        sharesFromDb(row.size, status, label),
        label,
        "size (acciones)",
      ),
      // Dos eras (DECISIONS.md): price = límite enviado, filledPrice =
      // ejecución; las FILLED heredadas del dataset la llevan en price.
      priceArs: executionPriceFromDb(row, label),
    };
  }
  requireCashUnitPrice(row.price, label);
  return {
    side,
    amountArs: cashAmountFromDb(row.size, status, label),
  };
};

/** Proyección NEW de orders (resting): side de trading, límite no-nulo. */
export const mapRestingOrderRow = (row: Order): RestingOrder => {
  const side = requiredField(row.side, "orders(NEW)", "side");
  if (side !== "BUY" && side !== "SELL") {
    // MARKET nunca queda NEW (se ejecuta al enviar) y CASH_* nunca descansan:
    // una fila así es corrupción, no se omite en silencio.
    throw new CorruptRowError("orders(NEW)", `side=${side} (no es side de trading)`);
  }
  const restingSide: TradingSide = side;
  const status = requiredField(row.status, "orders(NEW)", "status");
  return {
    id: row.id,
    instrumentId: requiredField(row.instrumentId, "orders(NEW)", "instrumentid"),
    side: restingSide,
    sizeShares: requiredField(
      sharesFromDb(row.size, status, "orders(NEW)"),
      "orders(NEW)",
      "size (acciones)",
    ),
    limitPriceArs: decimalFromDb(
      requiredField(row.price, "orders(NEW)", "price (límite)"),
    ),
  };
};

// ---------------------------------------------------------------------------
// order_events (auditoría append-only)
// ---------------------------------------------------------------------------

const metadataFromDb = (
  value: Prisma.JsonValue | null,
): OrderEventMetadata | null => {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    // El contrato es objeto JSON plano: escalar/array acá es corrupción.
    throw new CorruptRowError("order_events", "metadata (no es objeto JSON)");
  }
  return value;
};

export const mapOrderEventRow = (row: OrderEvent): OrderEventRecord => ({
  id: row.id,
  orderId: row.orderId,
  eventType: row.eventType,
  reason: row.reason,
  metadata: metadataFromDb(row.metadata),
  createdAt: row.createdAt,
});

/** Objeto JSON plano del contrato → input de la columna jsonb. */
export const metadataToDbParam = (
  metadata: OrderEventMetadata | null,
): Prisma.InputJsonObject | typeof Prisma.DbNull => {
  if (metadata === null) {
    // NULL de DB explícito (no JSON null): así lo exige Prisma para jsonb.
    return Prisma.DbNull;
  }
  // Frontera JSON: el contrato es Record<string, unknown> y el driver
  // espera InputJsonObject (valores JsonValue); el estrechamiento fino
  // no aporta seguridad — se serializa tal cual por el driver.
  return metadata as unknown as Prisma.InputJsonObject;
};

// ---------------------------------------------------------------------------
// instruments
// ---------------------------------------------------------------------------

export const mapInstrumentRow = (row: Instrument): InstrumentRecord => ({
  id: row.id,
  ticker: requiredField(row.ticker, "instruments", "ticker"),
  name: requiredField(row.name, "instruments", "name"),
  type: toInstrumentType(requiredField(row.type, "instruments", "type")),
});

// ---------------------------------------------------------------------------
// marketdata (fila cruda del DISTINCT ON: ver prisma-marketdata-repository)
// ---------------------------------------------------------------------------

/**
 * Fila del raw DISTINCT ON: nombres de COLUMNA de PG (lowercase), no de
 * Prisma. date ya viene como texto YYYY-MM-DD (to_char en la query) para
 * eludir el parseo Date↔zona-horaria; close/previousclose como texto
 * NUMERIC del driver pg (dinero nunca float).
 */
export interface MarketdataRawRow {
  readonly instrumentid: number | null;
  readonly date: string | null;
  readonly close: string | null;
  readonly previousclose: string | null;
}

export const mapMarketdataRawRow = (row: MarketdataRawRow): MarketdataSnapshot => ({
  instrumentId: requiredField(row.instrumentid, "marketdata", "instrumentid"),
  date: requiredField(row.date, "marketdata", "date"),
  closeArs: new FinancialDecimal(requiredField(row.close, "marketdata", "close")),
  previousCloseArs: new FinancialDecimal(
    requiredField(row.previousclose, "marketdata", "previousclose"),
  ),
});