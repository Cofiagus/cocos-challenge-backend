// Mappers Prisma ↔ contracts — FASE 2 (célula B).
//
// Filas de PG (tipos del cliente generado) ↔ registros de src/contracts.
// Dinero: Prisma.Decimal → decimal.js POR STRING (value.toString()),
// jamás por float; a la inversa, decimal.js → string para los parámetros
// de escritura (Prisma parsea el string).
//
// Campos NULL inesperados = corrupción: fallo ruidoso con CorruptRowError,
// nunca normalización en silencio.

import { Prisma, type Instrument, type Order, type OrderEvent } from "@prisma/client";
import { Decimal } from "decimal.js";
import type {
  InstrumentRecord,
  InstrumentType,
  MarketdataSnapshot,
  OrderEventMetadata,
  OrderEventRecord,
  OrderRecord,
  RestingOrder,
  SettledOrderMovement,
  TradingSide,
} from "../../contracts/index.js";
import { CorruptRowError } from "./corrupt-row.error.js";

/** Prisma.Decimal → decimal.js, por toString() (nunca float). */
export const decimalFromDb = (value: Prisma.Decimal): Decimal =>
  new Decimal(value.toString());

/** decimal.js → string para parámetros de escritura (Prisma parsea). */
export const decimalToDbParam = (value: Decimal): string => value.toString();

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
// orders
// ---------------------------------------------------------------------------

export const mapOrderRow = (row: Order): OrderRecord => ({
  id: row.id,
  instrumentId: requiredField(row.instrumentId, "orders", "instrumentid"),
  userId: requiredField(row.userId, "orders", "userid"),
  side: requiredField(row.side, "orders", "side"),
  type: requiredField(row.type, "orders", "type"),
  timeInForce: requiredField(row.timeInForce, "orders", "timeInForce"),
  status: requiredField(row.status, "orders", "status"),
  // Nullable en DB y en contrato (MARKET sin límite, orden no ejecutada).
  sizeShares: row.size,
  priceArs: row.price === null ? null : decimalFromDb(row.price),
  filledPriceArs: row.filledPrice === null ? null : decimalFromDb(row.filledPrice),
  filledAt: row.filledAt,
  idempotencyKey: row.idempotencyKey,
  datetime: requiredField(row.datetime, "orders", "datetime"),
});

/** Proyección FILLED de orders (movió cash/acciones). */
export const mapSettledMovementRow = (row: Order): SettledOrderMovement => ({
  instrumentId: requiredField(row.instrumentId, "orders(FILLED)", "instrumentid"),
  side: requiredField(row.side, "orders(FILLED)", "side"),
  sizeShares: requiredField(row.size, "orders(FILLED)", "size"),
  // Precio de EJECUCIÓN en dos eras (DECISIONS.md: price = límite enviado,
  // filledPrice = ejecución): las FILLED de la API llevan la ejecución en
  // filledPrice (price queda en el límite o NULL); las FILLED heredadas del
  // dataset la llevan en price (docs/database.md §3, pre-filledPrice). El
  // COALESCE lee la ejecución correcta en ambas — seam reportado por la
  // Célula E (QUESTION, opción A) y aplicado por el orquestador.
  priceArs: decimalFromDb(
    requiredField(
      row.filledPrice ?? row.price,
      "orders(FILLED)",
      "filledPrice|price",
    ),
  ),
});

/** Proyección NEW de orders (resting): side de trading, límite no-nulo. */
export const mapRestingOrderRow = (row: Order): RestingOrder => {
  const side = requiredField(row.side, "orders(NEW)", "side");
  if (side !== "BUY" && side !== "SELL") {
    // MARKET nunca queda NEW (se ejecuta al enviar) y CASH_* nunca descansan:
    // una fila así es corrupción, no se omite en silencio.
    throw new CorruptRowError("orders(NEW)", `side=${side} (no es side de trading)`);
  }
  const restingSide: TradingSide = side;
  return {
    id: row.id,
    instrumentId: requiredField(row.instrumentId, "orders(NEW)", "instrumentid"),
    side: restingSide,
    sizeShares: requiredField(row.size, "orders(NEW)", "size"),
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
  closeArs: new Decimal(requiredField(row.close, "marketdata", "close")),
  previousCloseArs: new Decimal(
    requiredField(row.previousclose, "marketdata", "previousclose"),
  ),
});