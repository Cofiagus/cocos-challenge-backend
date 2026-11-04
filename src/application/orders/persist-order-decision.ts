// Persistencia de una decisión de orden ya tomada: la comparten el envío de
// órdenes (UC-3) y las transferencias de cash (UC-5), que se modelan como
// órdenes del instrumento MONEDA.
//
// El orden de las escrituras es lo que hace válida la idempotencia:
//   1. createOrder es la PRIMERA escritura de la tx (claim con ON CONFLICT
//      DO NOTHING — DECISIONS.md): el draft completo, status incluido, ya
//      está decidido con las lecturas previas (las lecturas no son escrituras).
//   2. IDEMPOTENT_CONFLICT ⇒ 409 (el repo ya comparó el payload).
//      IDEMPOTENT_REPLAY ⇒ la orden ORIGINAL, sin evento nuevo.
//   3. CREATED ⇒ appendOrderEvent en la MISMA tx que la mutación.

import {
  API_ERROR_CODES,
  type OrderDraft,
  type OrderRejectionReason,
  type OrderRecord,
  type TransactionContext,
} from "../../contracts/index.js";
import type { OrderRepository } from "../../domain/ports/index.js";
import type { DecidedOrder } from "./decide-order.js";

/**
 * 409 de idempotencia: la misma Idempotency-Key llegó con otro payload. Es
 * UNA sola clase para todos los casos de uso que reclaman con esa key; el
 * router la mapea a status + apiErrorBody igual que a su error de aplicación.
 */
export class IdempotencyConflictError extends Error {
  readonly status = 409;
  readonly code = API_ERROR_CODES.IDEMPOTENCY_CONFLICT;

  constructor(existingOrderId: number) {
    super(
      `Idempotency-Key ya usada con otro payload (orden existente ${String(existingOrderId)}).`,
    );
    this.name = "IdempotencyConflictError";
  }
}

/** Campos comunes del draft; el estado y el fill los agrega la decisión. */
export type OrderDraftBase = Omit<
  OrderDraft,
  "status" | "sizeShares" | "filledPriceArs" | "filledAt"
>;

/** Salida: la fila persistida + la razón (REJECTED/CANCELLED; null si NEW/FILLED). */
export interface PersistedOrderDecision {
  readonly order: OrderRecord;
  readonly reason: OrderRejectionReason | null;
}

/**
 * Persiste la decisión: createOrder como PRIMERA escritura (claim idempotente)
 * y el evento de auditoría en la MISMA tx. Nada de esto corre si un error de
 * aplicación salió antes (el lock se libera con el rollback).
 */
export const persistOrderDecision = async (
  orders: OrderRepository,
  tx: TransactionContext,
  decided: DecidedOrder,
  base: OrderDraftBase,
): Promise<PersistedOrderDecision> => {
  const draft: OrderDraft = {
    ...base,
    status: decided.status,
    sizeShares: decided.sizeShares,
    filledPriceArs: decided.filledPriceArs,
    filledAt: decided.filledAt,
  };

  // PRIMERA ESCRITURA de la tx: claim idempotente (ON CONFLICT — DECISIONS.md).
  const created = await orders.createOrder(draft, tx);

  if (created.outcome === "IDEMPOTENT_CONFLICT") {
    throw new IdempotencyConflictError(created.order.id);
  }
  if (created.outcome === "IDEMPOTENT_REPLAY") {
    // Misma key + mismo payload: la orden ORIGINAL, 201 sin nuevo evento (el
    // reason del original vive en order_events).
    return { order: created.order, reason: null };
  }

  // Auditoría en la MISMA tx que la mutación (DECISIONS.md).
  await orders.appendOrderEvent(
    {
      orderId: created.order.id,
      eventType: decided.eventType,
      reason: decided.reason,
      metadata: decided.metadata,
    },
    tx,
  );

  return { order: created.order, reason: decided.reason };
};
