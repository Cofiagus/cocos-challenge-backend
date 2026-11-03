// UC-4 — cancelOrder (FASE 4 — Célula F): cancelar una orden NEW por usuario.
//
// Orquesta repos (B) DENTRO de UNA transacción con lock por usuario
// (withUserTransaction — DECISIONS.md), en el orden que hace válida la
// concurrencia:
//
//   1. orders.findById (lectura ROOT, sin tx): sólo resuelve el 404 y el
//      DUEÑO del lock. null ⇒ 404 ORDER_NOT_FOUND.
//   2. withUserTransaction(userId, tx): pg_advisory_xact_lock(userId)
//      serializa los submits Y las cancelaciones del usuario.
//   3. markCancelled(orderId, tx): el guard WHERE status='NEW' (B) ES la
//      transición atómica NEW → CANCELLED. null ⇒ ya no estaba NEW ⇒
//      422 ORDER_NOT_CANCELLABLE SIN mutar (ni evento).
//   4. appendOrderEvent CANCELLED en la MISMA tx que la mutación
//      (DECISIONS.md): reason null (las razones del contrato son de
//      REJECTED/IOC-FOK, no de una cancelación pedida por el usuario) y
//      metadata { origin: "USER" } (decisión firmada por el orquestador).
//
// La respuesta (router) es 200 OrderResponse con la fila CANCELLED — decisión
// firmada por el orquestador: 201 es para creación; DECISIONS.md no fija el
// status de cancelación.

import {
  API_ERROR_CODES,
  type ApiErrorCode,
  type OrderRecord,
} from "../../contracts/index.js";
import type { OrderRepository } from "../../domain/ports/index.js";

/**
 * Error de aplicación de la cancelación: el router lo mapea a status +
 * apiErrorBody. A diferencia del envío (E), NO hay códigos fuera del
 * contrato: 404 ORDER_NOT_FOUND y 422 ORDER_NOT_CANCELLABLE ya viven en
 * API_ERROR_CODES (la validación del borde es 400 del router, no de acá).
 */
export class CancelOrderError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CancelOrderError";
  }
}

/** Deps del caso de uso: la INTERFAZ del port, nunca una concreción. */
export interface CancelOrderDeps {
  /** Escritura de orders + auditoría + la transacción con lock por usuario. */
  readonly orders: OrderRepository;
}

/** Entrada del caso de uso: el orderId YA validado por Zod en el borde. */
export interface CancelOrderInput {
  readonly orderId: number;
}

/** Salida: la fila persistida (status CANCELLED tras markCancelled). */
export interface CancelOrderResult {
  readonly order: OrderRecord;
}

export const cancelOrder = async (
  deps: CancelOrderDeps,
  input: CancelOrderInput,
): Promise<CancelOrderResult> => {
  const { orderId } = input;

  // Lectura ROOT (sin tx): no participa de la transición — sólo resuelve el
  // 404 y quién es el dueño de la orden (⇒ dueño del lock).
  const existing = await deps.orders.findById(orderId);
  if (existing === null) {
    throw new CancelOrderError(
      404,
      API_ERROR_CODES.ORDER_NOT_FOUND,
      `No existe la orden ${String(orderId)}.`,
    );
  }
  const { userId } = existing;
  if (userId === null) {
    // mapOrderRow (B) ya falla ruidosamente (CorruptRowError) ante userid
    // NULL: este estrechamiento es sólo de tipos (inalcanzable en runtime).
    throw new Error(
      `Orden ${String(orderId)} sin userid (corrupción de fila — inalcanzable tras el mapper).`,
    );
  }

  // UNA transacción con pg_advisory_xact_lock(userId) (B): serializa esta
  // cancelación contra los submits y cancelaciones del MISMO usuario.
  // TODO lo de abajo corre con el lock tomado.
  return deps.orders.withUserTransaction(userId, async (tx) => {
    // Transición atómica: el guard WHERE status='NEW' del UPDATE (B) decide
    // y muta en UNA sentencia — dos DELETE concurrentes sobre la misma NEW
    // no pueden ambos ver count 1. La fila que devuelve ya está CANCELLED.
    const cancelled = await deps.orders.markCancelled(orderId, tx);
    if (cancelled === null) {
      // No estaba NEW (FILLED/CANCELLED/REJECTED) ⇒ 422 SIN mutar: el guard
      // count 0 deja la fila intacta y el evento de abajo nunca corre (el
      // throw rollback-ea la tx, que no escribió nada).
      throw new CancelOrderError(
        422,
        API_ERROR_CODES.ORDER_NOT_CANCELLABLE,
        `La orden ${String(orderId)} no está NEW (status '${existing.status}'): sólo se cancelan órdenes NEW.`,
      );
    }

    // Auditoría en la MISMA tx que la mutación (DECISIONS.md). Cancelación
    // pedida por el usuario: reason null y origen USER (decisión firmada).
    await deps.orders.appendOrderEvent(
      {
        orderId: cancelled.id,
        eventType: "CANCELLED",
        reason: null,
        metadata: { origin: "USER" },
      },
      tx,
    );

    return { order: cancelled };
  });
};