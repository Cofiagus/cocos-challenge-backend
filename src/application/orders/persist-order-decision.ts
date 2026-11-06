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
//
// D2/D3 (spec grandes montos): el draft está discriminado por `side`, así que
// las acciones (number ≤ INT4) y el monto cash (Decimal exacto) viajan cada
// uno con su tipo. El `Omit` es DISTRIBUTIVO a propósito: un Omit sobre la
// unión borraría los discriminantes y permitiría mezclar unidades.
//
// F2-IDEM: `base` puede traer `requestFingerprint` (huella del REQUEST
// original, calculada por el borde en src/http/shared/edge.ts). El spread de
// `draftOf` la arrastra al draft completo — acá no se recalcula nada — y el
// claim la persiste y la compara. Sin huella el claim cae a la comparación
// histórica de `size`, así que este camino no cambia para quien no la manda.

import {
  API_ERROR_CODES,
  type CashOrderDraft,
  type OrderDraft,
  type OrderRejectionReason,
  type OrderRecord,
  type TradingOrderDraft,
  type TransactionContext,
} from "../../contracts/index.js";
import type { OrderRepository } from "../../domain/ports/index.js";
import type { DecidedCashOrder, DecidedOrder } from "./decide-order.js";

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

/** Campos que agrega la decisión, no el draft base. */
type DecidedDraftFields =
  | "status"
  | "filledPriceArs"
  | "filledAt"
  | "sizeShares"
  | "amountArs";

/** `Omit` miembro a miembro: conserva el `side` literal de cada rama. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Campos comunes de un draft de TRADING; `sizeShares` lo agrega la decisión. */
export type TradingOrderDraftBase = DistributiveOmit<
  TradingOrderDraft,
  DecidedDraftFields
>;

/** Campos comunes de un draft de CASH; `amountArs` lo agrega la decisión. */
export type CashOrderDraftBase = DistributiveOmit<
  CashOrderDraft,
  DecidedDraftFields
>;

/**
 * Entrada de la persistencia: la decisión y el draft base SIEMPRE de la misma
 * unidad (trading con acciones, cash con monto), correlacionados por `kind`.
 */
export type PersistedOrderDecisionInput =
  | {
      readonly kind: "TRADING";
      readonly base: TradingOrderDraftBase;
      readonly decided: DecidedOrder;
    }
  | {
      readonly kind: "CASH";
      readonly base: CashOrderDraftBase;
      readonly decided: DecidedCashOrder;
    };

/** Salida: la fila persistida + la razón (REJECTED/CANCELLED; null si NEW/FILLED). */
export interface PersistedOrderDecision {
  readonly order: OrderRecord;
  readonly reason: OrderRejectionReason | null;
}

/** Draft completo: los campos comunes + los que decidió el caso de uso. */
const draftOf = (input: PersistedOrderDecisionInput): OrderDraft =>
  input.kind === "TRADING"
    ? {
        ...input.base,
        status: input.decided.status,
        sizeShares: input.decided.sizeShares,
        filledPriceArs: input.decided.filledPriceArs,
        filledAt: input.decided.filledAt,
      }
    : {
        ...input.base,
        status: input.decided.status,
        amountArs: input.decided.amountArs,
        filledPriceArs: input.decided.filledPriceArs,
        filledAt: input.decided.filledAt,
      };

/**
 * Persiste la decisión: createOrder como PRIMERA escritura (claim idempotente)
 * y el evento de auditoría en la MISMA tx. Nada de esto corre si un error de
 * aplicación salió antes (el lock se libera con el rollback).
 */
export const persistOrderDecision = async (
  orders: OrderRepository,
  tx: TransactionContext,
  input: PersistedOrderDecisionInput,
): Promise<PersistedOrderDecision> => {
  // PRIMERA ESCRITURA de la tx: claim idempotente (ON CONFLICT — DECISIONS.md).
  const created = await orders.createOrder(draftOf(input), tx);

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
      eventType: input.decided.eventType,
      reason: input.decided.reason,
      metadata: input.decided.metadata,
    },
    tx,
  );

  return { order: created.order, reason: input.decided.reason };
};
