// Tipos de dominio compartidos — el vocabulario con el que hablan las
// firmas de src/domain y los ports. Prisma NO entra acá (la infra mapea
// filas de Prisma ↔ estos tipos): el dominio puro se testea
// sin DB ni Express. Dinero SIEMPRE Decimal (AGENTS.md: nunca float).
//
// D2/D3 de specs/datos-financieros-grandes-montos.md: `size` tiene DOS
// unidades físicas (acciones en BUY/SELL, pesos en CASH_IN/CASH_OUT) y el
// contrato NO las mezcla: las uniones están discriminadas por `side`, así el
// compilador impide usar un monto como cantidad de acciones. Las cantidades
// agregadas/reservas son bigint (pueden superar el entero seguro de JS); las
// acciones POR ORDEN siguen number porque el rango aprobado es INT4.

import type {
  InstrumentType,
  OrderEventType,
  OrderRejectionReason,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingSide,
} from "./enums.js";
import type { FinancialDecimal } from "./financial-decimal.js";

// ---------------------------------------------------------------------------
// Canal de transacción
// ---------------------------------------------------------------------------

/**
 * Canal de transacción OPACO (DECISIONS.md: validación + inserción en una
 * transacción con lock por usuario; auditoría en la misma tx que la mutación).
 * La infra define el tipo real (cliente Prisma tx) y hace el
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
 * Campos de un movimiento FILLED de TRADING. `sizeShares` es la cantidad POR
 * ORDEN (number seguro: 1..INT4); `priceArs` es el precio unitario exacto. El
 * notional (size × price) se calcula en Decimal y puede superar la cota de
 * una fila.
 */
interface TradingMovementFields {
  readonly instrumentId: number;
  readonly sizeShares: number;
  readonly priceArs: FinancialDecimal;
}

/**
 * Cada side tiene su PROPIO literal como discriminante: así el narrowing por
 * `side` funciona en las dos ramas (cash ↔ trading), no sólo en la positiva.
 */
interface BuySettledMovement extends TradingMovementFields {
  readonly side: "BUY";
}

interface SellSettledMovement extends TradingMovementFields {
  readonly side: "SELL";
}

/**
 * Movimiento FILLED de CASH: movió un monto exacto en ARS (con centavos).
 * No tiene `sizeShares` (no son acciones) ni precio unitario ni instrumento:
 * el cash no forma posiciones y su precio histórico 1.00 no se usa en ningún
 * cálculo nuevo (spec §5).
 */
interface CashInSettledMovement {
  readonly side: "CASH_IN";
  readonly amountArs: FinancialDecimal;
}

interface CashOutSettledMovement {
  readonly side: "CASH_OUT";
  readonly amountArs: FinancialDecimal;
}

/** Movimiento FILLED que movió ACCIONES a un precio de ejecución. */
export type TradingSettledOrderMovement =
  | BuySettledMovement
  | SellSettledMovement;

/** Movimiento FILLED que movió un MONTO exacto en ARS. */
export type CashSettledOrderMovement =
  | CashInSettledMovement
  | CashOutSettledMovement;

/**
 * Movimiento liquidado del usuario, discriminado por `side`: BUY/SELL traen
 * acciones + precio; CASH_IN/CASH_OUT traen monto ARS. Un narrowing por
 * `side` deja accesible sólo la unidad que corresponde.
 */
export type SettledOrderMovement =
  | TradingSettledOrderMovement
  | CashSettledOrderMovement;

/**
 * Fila de orders con status NEW (resting): `price` es el LÍMITE enviado
 * (DECISIONS.md). MARKET nunca queda resting; side de trading sólo.
 */
export interface RestingOrder {
  readonly id: number;
  readonly instrumentId: number;
  readonly side: TradingSide;
  readonly sizeShares: number;
  readonly limitPriceArs: FinancialDecimal;
}

/**
 * Última fila de marketdata por `date` de un instrumento: el precio de
 * referencia del sistema (DECISIONS.md).
 */
export interface MarketdataSnapshot {
  readonly instrumentId: number;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly closeArs: FinancialDecimal;
  readonly previousCloseArs: FinancialDecimal;
}

/** Reservas derivadas de órdenes NEW (sin tabla — DECISIONS.md). */
export interface Reservations {
  /** Σ limit × size de BUY NEW. */
  readonly cashReservedArs: FinancialDecimal;
  /**
   * Σ size de SELL NEW, por instrumentId. bigint: la acumulación de muchas
   * órdenes válidas puede superar el entero seguro de JS (spec §4).
   */
  readonly sharesReservedByInstrument: ReadonlyMap<number, bigint>;
}

/**
 * Posición derivada con P&L no realizado sobre costo promedio ponderado
 * (las ventas no tocan el promedio). Cantidad 0 no se lista (la función la
 * excluye); negativa (BMA −10 del seed) se devuelve tal cual.
 */
export interface PositionPnl {
  readonly instrumentId: number;
  /** Acciones acumuladas; bigint, nunca se envía crudo a JSON (el borde la serializa a string). */
  readonly quantityShares: bigint;
  /** Costo promedio ponderado de las compras; 0 si nunca hubo compras. */
  readonly weightedAverageCostArs: FinancialDecimal;
  /** quantity × close. Null si sin precio (NO_PRICE). */
  readonly marketValueArs: FinancialDecimal | null;
  readonly priceAvailable: boolean;
  /** (marketValue − quantity × avgCost) / (quantity × avgCost) × 100. Null si NO_PRICE o costo 0. */
  readonly totalReturnPctX100: FinancialDecimal | null;
}

// ---------------------------------------------------------------------------
// Registros (filas tipadas, sin Prisma)
// ---------------------------------------------------------------------------

/**
 * Campos comunes de una fila de orders. instrumentId/userId conservan la
 * nullabilidad legacy de la tabla (el mapper falla ruidosamente cuando la
 * fila operable no los trae). side/type/status/timeInForce NO son opcionales:
 * en el seed siempre están, y la API nunca crea filas sin ellos.
 */
interface OrderRecordCommon {
  readonly id: number;
  readonly instrumentId: number | null;
  readonly userId: number | null;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly status: OrderStatus;
  /** Límite (LIMIT) o el precio del dataset legacy; null en MARKET sin límite. */
  readonly priceArs: FinancialDecimal | null;
  readonly filledPriceArs: FinancialDecimal | null;
  readonly filledAt: Date | null;
  readonly idempotencyKey: string | null;
  readonly datetime: Date;
}

/**
 * Fila de orders de TRADING: la columna física `size` son ACCIONES.
 * `sizeShares` es null sólo donde la fila legacy lo permite; nunca un monto.
 */
interface TradingOrderRecordFields {
  /** Acciones; NULL sólo donde la fila legacy lo permite. Nunca un monto cash. */
  readonly sizeShares: number | null;
}

/** Fila de orders de CASH: la columna física `size` es un MONTO en ARS. */
interface CashOrderRecordFields {
  /** Monto exacto en ARS (precio unitario histórico 1.00 — UC-5). */
  readonly amountArs: FinancialDecimal;
}

interface BuyOrderRecord extends OrderRecordCommon, TradingOrderRecordFields {
  readonly side: "BUY";
}

interface SellOrderRecord extends OrderRecordCommon, TradingOrderRecordFields {
  readonly side: "SELL";
}

interface CashInOrderRecord extends OrderRecordCommon, CashOrderRecordFields {
  readonly side: "CASH_IN";
}

interface CashOutOrderRecord extends OrderRecordCommon, CashOrderRecordFields {
  readonly side: "CASH_OUT";
}

/** Fila de orders de trading (BUY/SELL): su `size` son acciones. */
export type TradingOrderRecord = BuyOrderRecord | SellOrderRecord;

/** Fila de orders de cash (CASH_IN/CASH_OUT): su `size` es un monto ARS. */
export type CashOrderRecord = CashInOrderRecord | CashOutOrderRecord;

/**
 * Fila de orders, discriminada por `side`: `sizeShares` sólo existe en
 * BUY/SELL y `amountArs` sólo en CASH_IN/CASH_OUT. Documenta la deuda del
 * campo físico de doble propósito sin esconderla en un `number` ambiguo.
 */
export type OrderRecord = TradingOrderRecord | CashOrderRecord;

/**
 * Campos comunes de una orden a persistir. El status ya está decidido por la
 * capa de aplicación (NEW/FILLED/REJECTED/CANCELLED).
 */
interface OrderDraftCommon {
  readonly userId: number;
  readonly instrumentId: number;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly status: OrderStatus;
  /** Límite (LIMIT); null en MARKET. */
  readonly priceArs: FinancialDecimal | null;
  readonly filledPriceArs: FinancialDecimal | null;
  readonly filledAt: Date | null;
  readonly idempotencyKey: string | null;
  readonly datetime: Date;
  /**
   * Huella canónica del REQUEST original (F2-IDEM, Q1=A): la calcula el borde
   * (`requestFingerprintOf` en src/contracts/request-fingerprint.ts) sobre el body ya
   * validado, ANTES de derivar `size`, y `createOrder` la persiste para
   * comparar dos envíos con la misma Idempotency-Key. Ausente/null en filas
   * legacy y en los envíos que no pasan por el borde con monto original
   * (drafts de tests, transferencias): ahí el claim cae a la comparación
   * histórica de `size`.
   */
  readonly requestFingerprint?: string;
}

/** Campos de una orden de TRADING a persistir: `size` son acciones enteras. */
interface TradingOrderDraftFields {
  /** Acciones enteras > 0 (≤ INT4). */
  readonly sizeShares: number;
}

/** Campos de una orden de CASH a persistir: `size` es el monto exacto en ARS. */
interface CashOrderDraftFields {
  /** Monto exacto en ARS (> 0, con centavos; sin floor — D4). */
  readonly amountArs: FinancialDecimal;
}

interface BuyOrderDraft extends OrderDraftCommon, TradingOrderDraftFields {
  readonly side: "BUY";
}

interface SellOrderDraft extends OrderDraftCommon, TradingOrderDraftFields {
  readonly side: "SELL";
}

interface CashInOrderDraft extends OrderDraftCommon, CashOrderDraftFields {
  readonly side: "CASH_IN";
}

interface CashOutOrderDraft extends OrderDraftCommon, CashOrderDraftFields {
  readonly side: "CASH_OUT";
}

/** Orden de TRADING a persistir: `size` son acciones enteras (1..INT4). */
export type TradingOrderDraft = BuyOrderDraft | SellOrderDraft;

/** Orden de CASH a persistir: `size` es el monto exacto en ARS (> 0 con centavos). */
export type CashOrderDraft = CashInOrderDraft | CashOutOrderDraft;

/**
 * Orden a persistir: la PRIMERA escritura de la transacción de envío
 * (claim idempotente con ON CONFLICT DO NOTHING — DECISIONS.md), discriminada
 * por `side` para que cada unidad viaje con su tipo.
 */
export type OrderDraft = TradingOrderDraft | CashOrderDraft;

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
