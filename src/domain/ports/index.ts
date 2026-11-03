// Ports (interfaces de repositorio): SOLO firmas.
// La infra los implementa contra Prisma (mapeando
// Prisma ↔ tipos de src/contracts); las capas de aplicación los consumen.
// Dinero siempre Decimal, filas tipadas con los registros de contracts.
// TransactionContext (contracts/domain) existe para no meter Prisma en el
// dominio: la semántica de tx única + lock por usuario es de DECISIONS.md y
// viaja como tipo opaco que solo la infra concreta narrowcea.

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
  TransactionContext,
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
 * Concurrencia (DECISIONS.md): withUserTransaction abre la transacción de
 * envío con advisory lock por usuario y corre validación + escrituras
 * dentro; los métodos de acá y los reads del portfolio reciben el MISMO tx.
 */
export interface OrderRepository {
  /**
   * Abre UNA transacción con advisory lock por usuario (pg_advisory_xact_lock
   * sobre userId — DECISIONS.md) y corre operation dentro. El tx que entrega
   * se re-pasa a createOrder/appendOrderEvent/markFilled/markCancelled y a los
   * reads que participan de la validación (los de PortfolioReadRepository).
   */
  readonly withUserTransaction: <T>(
    userId: number,
    operation: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  /** Insert con claim idempotente (ON CONFLICT DO NOTHING sobre UNIQUE(userId,
   * idempotencyKey)) — PRIMERA escritura de la transacción de envío. */
  readonly createOrder: (
    draft: OrderDraft,
    tx: TransactionContext,
  ) => Promise<CreateOrderResult>;
  /** Evento de auditoría en la MISMA transacción que la mutación. Append-only. */
  readonly appendOrderEvent: (
    event: OrderEventDraft,
    tx: TransactionContext,
  ) => Promise<OrderEventRecord>;
  /**
   * Fila de orders por id. Sin tx: lectura suelta del cancel (resuelve el
   * 404 y el dueño del lock ANTES de abrir la transacción). Con tx: releer
   * DENTRO de la misma ventana de la transacción (el status del mensaje
   * 422 del cancel es el vigente al fallar el guard, no el de una lectura
   * previa que pudo quedar vieja).
   */
  readonly findById: (
    orderId: number,
    tx?: TransactionContext,
  ) => Promise<OrderRecord | null>;
  /**
   * Transición NEW → FILLED guardada por estado (WHERE status = 'NEW';
   * idempotente ante evaluaciones concurrentes). Null si ya no estaba NEW.
   * Hoy no se usa (MARKET se inserta FILLED); es el enchufe del
   * matching de evolución.
   */
  readonly markFilled: (
    orderId: number,
    filledPriceArs: Decimal,
    filledAt: Date,
    tx: TransactionContext,
  ) => Promise<OrderRecord | null>;
  /**
   * Transición NEW → CANCELLED (cancelar orden, UC-4), guardada por
   * estado. Null si no estaba NEW (la API responde 422).
   */
  readonly markCancelled: (
    orderId: number,
    tx: TransactionContext,
  ) => Promise<OrderRecord | null>;
}

// Alias local de legibilidad (evita el galimatías OrderRecord | null en el
// findById del port).

/**
 * Lado de lectura del portfolio (UC-1). userExists resuelve el 404 de
 * usuario inexistente también para POST /orders y POST /transfers.
 */
export interface PortfolioReadRepository {
  readonly userExists: (
    userId: number,
    tx?: TransactionContext,
  ) => Promise<boolean>;
  /** Movimientos FILLED del usuario. tx obligatorio EN el submit (validez de la validación de fondos). */
  readonly listSettledMovements: (
    userId: number,
    tx?: TransactionContext,
  ) => Promise<readonly SettledOrderMovement[]>;
  /** Órdenes NEW del usuario (reservas). Ídem tx. */
  readonly listRestingOrders: (
    userId: number,
    tx?: TransactionContext,
  ) => Promise<readonly RestingOrder[]>;
}

/**
 * Catálogo de instrumentos. findByTicker/findById PUEDEN devolver MONEDA:
 * la API la rechaza con 400 (DECISIONS.md); searchByQuery la EXCLUYE.
 * El tx opcional es simetría con PortfolioReadRepository: resolver
 * instrumentId/ticker es una lectura de REFERENCIA del submit y debe poder
 * correr dentro de la misma ventana de la transacción cuando el caller la
 * tiene (no-NEW fuera de la tx que el submit ya validó).
 */
export interface InstrumentRepository {
  readonly findById: (
    instrumentId: number,
    tx?: TransactionContext,
  ) => Promise<InstrumentRecord | null>;
  /** Ticker exacto (comparación case-insensitive). */
  readonly findByTicker: (
    ticker: string,
    tx?: TransactionContext,
  ) => Promise<InstrumentRecord | null>;
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
 * El tx opcional es simetría con PortfolioReadRepository: el precio de
 * referencia del submit (MARKET, valoración) debe poder leerse dentro de la
 * misma ventana de la transacción cuando el caller la tiene.
 */
export interface MarketdataRepository {
  readonly getLatestSnapshot: (
    instrumentId: number,
    tx?: TransactionContext,
  ) => Promise<MarketdataSnapshot | null>;
  /**
   * Última fila por date de CADA instrumentId pedido (sin duplicados),
   * para armar portfolio/búsqueda sin N+1.
   */
  readonly getLatestSnapshots: (
    instrumentIds: readonly number[],
    tx?: TransactionContext,
  ) => Promise<readonly MarketdataSnapshot[]>;
}
