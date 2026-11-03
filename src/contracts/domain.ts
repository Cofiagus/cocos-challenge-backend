// Tipos de dominio compartidos — el vocabulario con el que hablan las
// firmas de src/domain y los ports. Prisma NO entra acá (la célula B de
// FASE 2 mapea filas de Prisma ↔ estos tipos): el dominio puro se testea
// sin DB ni Express. Dinero SIEMPRE Decimal (AGENTS.md: nunca float).

import { Decimal } from "decimal.js";
import type {
  InstrumentType,
  OrderEventType,
  OrderRejectionReason,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingSide,
} from "./enums.js";

// ---------------------------------------------------------------------------
// Canal de transacción
// ---------------------------------------------------------------------------

/**
 * Canal de transacción OPACO (DECISIONS.md: validación + inserción en una
 * transacción con lock por usuario; auditoría en la misma tx que la mutación).
 * La infra (célula B) define el tipo real (cliente Prisma tx) y hace el
 * narrowing; la capa de aplicación SOLO lo recibe de withUserTransaction y lo
 * re-pasa a los métodos de repositorio. Nunca se construye en dominio/app.
 */
export interface TransactionContext {
  readonly __brand: "TransactionContext";
}

// ---------------------------------------------------------------------------
// Insumos de cálculo (proyecciones de orders — docs/database.md §3)
// ---------------------------------------------------------------------------

/**
 * Fila de orders con status FILLED: movió cash/acciones. `price` es el
 * precio de EJECUCIÓN (en el dataset la columna price guarda la ejecución).
 */
export interface SettledOrderMovement {
  readonly instrumentId: number;
  readonly side: OrderSide;
  readonly sizeShares: number;
  readonly priceArs: Decimal;
}

/**
 * Fila de orders con status NEW (resting): `price` es el LÍMITE enviado
 * (DECISIONS.md). MARKET nunca queda resting; side de trading sólo.
 */
export interface RestingOrder {
  readonly id: number;
  readonly instrumentId: number;
  readonly side: TradingSide;
  readonly sizeShares: number;
  readonly limitPriceArs: Decimal;
}

/**
 * Última fila de marketdata por `date` de un instrumento: el precio de
 * referencia del sistema (DECISIONS.md).
 */
export interface MarketdataSnapshot {
  readonly instrumentId: number;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly closeArs: Decimal;
  readonly previousCloseArs: Decimal;
}

/** Reservas derivadas de órdenes NEW (sin tabla — DECISIONS.md). */
export interface Reservations {
  /** Σ limit × size de BUY NEW. */
  readonly cashReservedArs: Decimal;
  /** Σ size de SELL NEW, por instrumentId. */
  readonly sharesReservedByInstrument: ReadonlyMap<number, number>;
}

/**
 * Posición derivada con P&L no realizado sobre costo promedio ponderado
 * (las ventas no tocan el promedio). Cantidad 0 no se lista (la función la
 * excluye); negativa (BMA −10 del seed) se devuelve tal cual.
 */
export interface PositionPnl {
  readonly instrumentId: number;
  readonly quantityShares: number;
  /** Costo promedio ponderado de las compras; 0 si nunca hubo compras. */
  readonly weightedAverageCostArs: Decimal;
  /** quantity × close. Null si sin precio (NO_PRICE). */
  readonly marketValueArs: Decimal | null;
  readonly priceAvailable: boolean;
  /** (marketValue − quantity × avgCost) / (quantity × avgCost) × 100. Null si NO_PRICE o costo 0. */
  readonly totalReturnPctX100: Decimal | null;
}

// ---------------------------------------------------------------------------
// Registros (filas tipadas, sin Prisma)
// ---------------------------------------------------------------------------

/**
 * Fila de orders. side/type/status/timeInForce NO son opcionales: en el
 * seed siempre están, y la API nunca crea filas sin ellos. Si una fila
 * viniera NULL es corrupción de datos y el mapper de infra debe fallar
 * ruidosamente (nunca normalizar en silencio).
 */
export interface OrderRecord {
  readonly id: number;
  readonly instrumentId: number | null;
  readonly userId: number | null;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly status: OrderStatus;
  readonly sizeShares: number | null;
  /** Límite (LIMIT) o el precio del dataset legacy; null en MARKET sin límite. */
  readonly priceArs: Decimal | null;
  readonly filledPriceArs: Decimal | null;
  readonly filledAt: Date | null;
  readonly idempotencyKey: string | null;
  readonly datetime: Date;
}

/**
 * Orden a persistir: la PRIMERA escritura de la transacción de envío
 * (claim idempotente con ON CONFLICT DO NOTHING — DECISIONS.md). El status
 * ya está decidido por la capa de aplicación (NEW/FILLED/REJECTED/CANCELLED).
 */
export interface OrderDraft {
  readonly userId: number;
  readonly instrumentId: number;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly status: OrderStatus;
  readonly sizeShares: number;
  /** Límite (LIMIT); null en MARKET. */
  readonly priceArs: Decimal | null;
  readonly filledPriceArs: Decimal | null;
  readonly filledAt: Date | null;
  readonly idempotencyKey: string | null;
  readonly datetime: Date;
}

/** Metadata de auditoría: objeto JSON plano (jsonb en DB), sin `any`. */
export type OrderEventMetadata = Readonly<Record<string, unknown>>;

/** Evento de order_events a insertar (append-only). */
export interface OrderEventDraft {
  readonly orderId: number;
  readonly eventType: OrderEventType;
  readonly reason: OrderRejectionReason | null;
  readonly metadata: OrderEventMetadata | null;
}

/** Fila de order_events leída. */
export interface OrderEventRecord extends OrderEventDraft {
  readonly id: number;
  readonly createdAt: Date;
}

/**
 * Resultado del insert con claim idempotente (UNIQUE(userId, idempotencyKey)
 * con ON CONFLICT DO NOTHING — DECISIONS.md).
 */
export type CreateOrderResult =
  | { readonly outcome: "CREATED"; readonly order: OrderRecord }
  /** Misma key + mismo payload: se devuelve la orden original. */
  | { readonly outcome: "IDEMPOTENT_REPLAY"; readonly order: OrderRecord }
  /** Misma key + payload distinto: 409 en la API. */
  | { readonly outcome: "IDEMPOTENT_CONFLICT"; readonly order: OrderRecord };

/** Fila de instruments. ticker/name/type NO opcionales: el seed siempre los trae. */
export interface InstrumentRecord {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly type: InstrumentType;
}
