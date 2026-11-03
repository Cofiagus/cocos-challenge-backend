// Ports (interfaces de repositorio) — FASE 1 (Célula 0): SOLO firmas.
// La célula B de FASE 2 los implementa contra Prisma (mapeando
// Prisma ↔ tipos de src/contracts); las capas de aplicación los consumen.
// Dinero siempre Decimal, filas tipadas con los registros de contracts.

import { Decimal } from "decimal.js";
import type {
  CreateOrderResult,
  InstrumentRecord,
  MarketdataSnapshot,
  OrderDraft,
  OrderEventDraft,
  OrderEventRecord,
  OrderRecord,
  RestingOrder,
  SettledOrderMovement,
} from "../../contracts/index.js";

/**
 * Escritura y lectura de orders + auditoría append-only.
 *
 * Idempotencia (DECISIONS.md): createOrder es la PRIMERA escritura de la
 * transacción de envío, con ON CONFLICT DO NOTHING sobre
 * UNIQUE(userId, idempotencyKey); compara el payload del draft contra la
 * fila existente para distinguir IDEMPOTENT_REPLAY de
 * IDEMPOTENT_CONFLICT (409).
 *
 * Concurrencia (DECISIONS.md): la transacción de envío toma lock por
 * usuario (pg_advisory_xact_lock o SELECT ... FOR UPDATE) antes de validar
 * fondos — lo coordina la capa de aplicación, no el repositorio.
 */
export interface OrderRepository {
  /** Insert con claim idempotente (primera escritura del envío). */
  readonly createOrder: (draft: OrderDraft) => Promise<CreateOrderResult>;
  /** Evento de auditoría, MISMA transacción que la mutación. Append-only. */
  readonly appendOrderEvent: (
    event: OrderEventDraft,
  ) => Promise<OrderEventRecord>;
  readonly findById: (orderId: number) => Promise<OrderRecord | null>;
  /**
   * Transición NEW → FILLED guardada por estado (WHERE status = 'NEW';
   * idempotente ante evaluaciones concurrentes). Null si ya no estaba NEW.
   * En FASE 3 no se usa (MARKET se inserta FILLED); es el enchufe del
   * matching de evolución.
   */
  readonly markFilled: (
    orderId: number,
    filledPriceArs: Decimal,
    filledAt: Date,
  ) => Promise<OrderRecord | null>;
  /**
   * Transición NEW → CANCELLED (cancelar orden, UC-4), guardada por
   * estado. Null si no estaba NEW (la API responde 422).
   */
  readonly markCancelled: (orderId: number) => Promise<OrderRecord | null>;
}

// Alias local de legibilidad (evita el galimatías OrderRecord | null en el
// findById del port).

/**
 * Lado de lectura del portfolio (UC-1). userExists resuelve el 404 de
 * usuario inexistente también para POST /orders y POST /transfers.
 */
export interface PortfolioReadRepository {
  readonly userExists: (userId: number) => Promise<boolean>;
  /** Movimientos FILLED del usuario: insumo de cash y posiciones. */
  readonly listSettledMovements: (
    userId: number,
  ) => Promise<readonly SettledOrderMovement[]>;
  /** Órdenes NEW del usuario: insumo de reservas. */
  readonly listRestingOrders: (
    userId: number,
  ) => Promise<readonly RestingOrder[]>;
}

/**
 * Catálogo de instrumentos. findByTicker/FindById PUEDEN devolver MONEDA:
 * la API la rechaza con 400 (DECISIONS.md); searchByQuery la EXCLUYE.
 */
export interface InstrumentRepository {
  readonly findById: (
    instrumentId: number,
  ) => Promise<InstrumentRecord | null>;
  /** Ticker exacto (comparación case-insensitive). */
  readonly findByTicker: (ticker: string) => Promise<InstrumentRecord | null>;
  /**
   * Búsqueda parcial case-insensitive sobre ticker y/o name, EXCLUYE
   * MONEDA, ordenada y limitada por `limit`.
   */
  readonly searchByQuery: (
    query: string,
    limit: number,
  ) => Promise<readonly InstrumentRecord[]>;
}

/**
 * Precios de marketdata: siempre la ÚLTIMA fila por `date` del instrumento
 * (precio de referencia — DECISIONS.md). Null si no hay datos (NO_PRICE).
 */
export interface MarketdataRepository {
  readonly getLatestSnapshot: (
    instrumentId: number,
  ) => Promise<MarketdataSnapshot | null>;
  /**
   * Última fila por date de CADA instrumentId pedido (sin duplicados),
   * para armar portfolio/búsqueda sin N+1.
   */
  readonly getLatestSnapshots: (
    instrumentIds: readonly number[],
  ) => Promise<readonly MarketdataSnapshot[]>;
}