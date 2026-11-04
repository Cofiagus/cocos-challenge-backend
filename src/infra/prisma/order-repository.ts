// PrismaOrderRepository — FASE 2 (célula B). Implementa OrderRepository de
// src/domain/ports contra Prisma 7 + @prisma/adapter-pg.
//
// DECISIONS.md:
//  - withUserTransaction: UNA transacción con pg_advisory_xact_lock(userId)
//    como PRIMERA sentencia; validación + escrituras adentro.
//  - Idempotencia: createOrder es la PRIMERA escritura del envío, con
//    ON CONFLICT DO NOTHING sobre UNIQUE(userid, idempotencyKey); misma
//    key + mismo payload ⇒ devuelve la original (REPLAY); payload distinto
//    ⇒ IDEMPOTENT_CONFLICT (la API lo resuelve 409).
//  - Auditoría: appendOrderEvent inserta en la MISMA tx que la mutación.
//  - markFilled/markCancelled: guard por estado (WHERE status='NEW'),
//    null si no estaba NEW.

import { PrismaClient, type Order, type Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import type {
  CreateOrderResult,
  OrderDraft,
  OrderEventDraft,
  OrderEventRecord,
  OrderRecord,
  TransactionContext,
} from "../../contracts/index.js";
import type { OrderRepository } from "../../domain/ports/index.js";
import { getPrismaClient } from "../../lib/prisma-client.js";
import { CorruptRowError } from "./corrupt-row.error.js";
import {
  decimalFromDb,
  decimalToDbParam,
  mapOrderEventRow,
  mapOrderRow,
  metadataToDbParam,
} from "./mappers.js";
import {
  brandTransactionContext,
  unbrandTransactionContext,
} from "./transaction-context.js";

// ---------------------------------------------------------------------------
// Insert idempotente — piezas puras/aisladas de createOrder
// ---------------------------------------------------------------------------

/** Parámetros de escritura del dinero del draft (Decimal → string; NULL se conserva). */
interface OrderWriteParams {
  readonly price: string | null;
  readonly filledPrice: string | null;
}

const orderWriteParams = (draft: OrderDraft): OrderWriteParams => ({
  price: draft.priceArs === null ? null : decimalToDbParam(draft.priceArs),
  filledPrice:
    draft.filledPriceArs === null ? null : decimalToDbParam(draft.filledPriceArs),
});

/** Datos del INSERT directo (sin idempotencyKey no hay claim que defender). */
const orderCreateData = (
  draft: OrderDraft,
  params: OrderWriteParams,
): Prisma.OrderUncheckedCreateInput => ({
  instrumentId: draft.instrumentId,
  userId: draft.userId,
  size: draft.sizeShares,
  price: params.price,
  type: draft.type,
  side: draft.side,
  status: draft.status,
  datetime: draft.datetime,
  timeInForce: draft.timeInForce,
  filledPrice: params.filledPrice,
  filledAt: draft.filledAt,
  idempotencyKey: null,
});

/** price de la fila vs price del draft (Decimal por string, nunca float). */
const pricesEqual = (
  dbValue: Prisma.Decimal | null,
  draftValue: Decimal | null,
): boolean => {
  if (dbValue === null || draftValue === null) {
    return dbValue === null && draftValue === null;
  }
  return decimalFromDb(dbValue).equals(draftValue);
};

/**
 * Mismo PAYLOAD idempotente: instrumentId/side/type/size/price/timeInForce
 * (DECISIONS.md; status/filled* los decide la app, no integran el payload).
 */
const sameOrderPayload = (row: Order, draft: OrderDraft): boolean =>
  row.instrumentId === draft.instrumentId &&
  row.side === draft.side &&
  row.type === draft.type &&
  row.timeInForce === draft.timeInForce &&
  row.size === draft.sizeShares &&
  pricesEqual(row.price, draft.priceArs);

interface ClaimedOrderRow {
  /** true si ESTE envío insertó la fila; false si la key ya estaba reclamada. */
  readonly inserted: boolean;
  readonly row: Order;
}

/**
 * Claim idempotente: INSERT ... ON CONFLICT DO NOTHING sobre
 * UNIQUE(userid, idempotencyKey) — PRIMERA escritura del envío. Count 1 ⇒
 * insertamos; 0 ⇒ otra orden YA reclamó la key. Devuelve la fila única
 * (insertada ahora o preexistente).
 */
const claimOrderRow = async (
  db: Prisma.TransactionClient,
  draft: OrderDraft,
  params: OrderWriteParams,
): Promise<ClaimedOrderRow> => {
  const inserted = await db.$executeRaw`
    INSERT INTO orders
      ("instrumentid", "userid", "size", "price", "type", "side", "status",
       "datetime", "timeInForce", "filledPrice", "filledAt", "idempotencyKey")
    VALUES
      (${draft.instrumentId}, ${draft.userId}, ${draft.sizeShares}, ${params.price},
       ${draft.type}, ${draft.side}, ${draft.status}, ${draft.datetime},
       ${draft.timeInForce}, ${params.filledPrice}, ${draft.filledAt},
       ${draft.idempotencyKey})
    ON CONFLICT ("userid", "idempotencyKey") DO NOTHING
  `;
  if (inserted !== 0 && inserted !== 1) {
    throw new CorruptRowError("orders", "insert (count inesperado)");
  }

  // La fila (insertada ahora o preexistente): única por (userid, key).
  const row = await db.order.findFirst({
    where: { userId: draft.userId, idempotencyKey: draft.idempotencyKey },
    orderBy: { id: "asc" },
  });
  if (row === null) {
    // El ON CONFLICT garantiza que la fila exista: no encontrarla es corrupción.
    throw new CorruptRowError("orders", "fila del claim idempotente");
  }
  return { inserted: inserted === 1, row };
};

export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly client: PrismaClient = getPrismaClient()) {}

  // -------------------------------------------------------------------------
  // Transacción de envío (lock por usuario)
  // -------------------------------------------------------------------------

  readonly withUserTransaction = <T>(
    userId: number,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> =>
    // Tx de escritura financiera: lock por usuario + validación + auditoría.
    // Los defaults de Prisma (timeout 5s / maxWait 2s) están dimensionados
    // para CRUD corto: bajo contención del advisory lock abortarían con
    // P2028 y el usuario vería un 500 en lugar de su respuesta.
    this.client.$transaction(
      async (prismaTx) => {
        // PRIMERA sentencia de la tx: advisory lock POR USUARIO. Se libera
        // solo al COMMIT/ROLLBACK de ESTA transacción (xact ⇒ sin leaks).
        await prismaTx.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;
        return operation(brandTransactionContext(prismaTx));
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

  // -------------------------------------------------------------------------
  // Insert idempotente (primera escritura)
  // -------------------------------------------------------------------------

  readonly createOrder = async (
    draft: OrderDraft,
    tx: TransactionContext,
  ): Promise<CreateOrderResult> => {
    const db = unbrandTransactionContext(tx);
    const params = orderWriteParams(draft);

    if (draft.idempotencyKey === null) {
      // Sin key no hay claim que defender: INSERT directo (las filas NULL
      // nunca chocan el UNIQUE: PG trata NULL ≠ NULL).
      const row = await db.order.create({
        data: orderCreateData(draft, params),
      });
      return { outcome: "CREATED", order: mapOrderRow(row) };
    }

    const { inserted, row } = await claimOrderRow(db, draft, params);
    if (inserted) {
      return { outcome: "CREATED", order: mapOrderRow(row) };
    }

    // Conflicto: el payload decide REPLAY vs CONFLICT (la API mapea 409).
    return {
      outcome: sameOrderPayload(row, draft)
        ? "IDEMPOTENT_REPLAY"
        : "IDEMPOTENT_CONFLICT",
      order: mapOrderRow(row),
    };
  };

  // -------------------------------------------------------------------------
  // Auditoría append-only (misma tx)
  // -------------------------------------------------------------------------

  readonly appendOrderEvent = async (
    event: OrderEventDraft,
    tx: TransactionContext,
  ): Promise<OrderEventRecord> => {
    const db = unbrandTransactionContext(tx);
    const row = await db.orderEvent.create({
      data: {
        orderId: event.orderId,
        eventType: event.eventType,
        reason: event.reason,
        metadata: metadataToDbParam(event.metadata),
      },
    });
    return mapOrderEventRow(row);
  };

  // -------------------------------------------------------------------------
  // Lecturas
  // -------------------------------------------------------------------------

  readonly findById = async (orderId: number): Promise<OrderRecord | null> => {
    // Lectura suelta: cliente raíz, sin tx (no participa de la validación).
    const row = await this.client.order.findUnique({ where: { id: orderId } });
    return row === null ? null : mapOrderRow(row);
  };

  // -------------------------------------------------------------------------
  // Transiciones guardadas por estado
  // -------------------------------------------------------------------------

  readonly markFilled = async (
    orderId: number,
    filledPriceArs: Decimal,
    filledAt: Date,
    tx: TransactionContext,
  ): Promise<OrderRecord | null> => {
    const db = unbrandTransactionContext(tx);
    // UPDATE ... WHERE status='NEW' (guard por estado): updateMany atómico
    // devuelve el count; 0 ⇒ ya no estaba NEW ⇒ null sin mutar.
    const guard = await db.order.updateMany({
      where: { id: orderId, status: "NEW" },
      data: {
        status: "FILLED",
        filledPrice: decimalToDbParam(filledPriceArs),
        filledAt,
      },
    });
    return this.readAfterGuard(db, orderId, guard.count);
  };

  readonly markCancelled = async (
    orderId: number,
    tx: TransactionContext,
  ): Promise<OrderRecord | null> => {
    const db = unbrandTransactionContext(tx);
    const guard = await db.order.updateMany({
      where: { id: orderId, status: "NEW" },
      data: { status: "CANCELLED" },
    });
    return this.readAfterGuard(db, orderId, guard.count);
  };

  private readonly readAfterGuard = async (
    db: Prisma.TransactionClient,
    orderId: number,
    guardCount: number,
  ): Promise<OrderRecord | null> => {
    if (guardCount === 0) {
      return null;
    }
    const row = await db.order.findUnique({ where: { id: orderId } });
    if (row === null) {
      // updateMany contó 1 ⇒ la fila existe; no encontrarla es corrupción.
      throw new CorruptRowError("orders", `id=${orderId} tras el UPDATE guard`);
    }
    return mapOrderRow(row);
  };
}