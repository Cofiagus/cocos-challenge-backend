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

import { PrismaClient, type Prisma } from "@prisma/client";
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
  resolveDbExecutor,
  unbrandTransactionContext,
  type DbExecutor,
} from "./transaction-context.js";

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

    // Dinero → string (parámetros de escritura); Prisma/pg parsean el texto
    // a NUMERIC: jamás pasa por float.
    const priceParam =
      draft.priceArs === null ? null : decimalToDbParam(draft.priceArs);
    const filledPriceParam =
      draft.filledPriceArs === null ? null : decimalToDbParam(draft.filledPriceArs);

    if (draft.idempotencyKey === null) {
      // Sin key no hay claim que defender: INSERT directo (las filas NULL
      // nunca chocan el UNIQUE: PG trata NULL ≠ NULL).
      const row = await db.order.create({
        data: {
          instrumentId: draft.instrumentId,
          userId: draft.userId,
          size: draft.sizeShares,
          price: priceParam,
          type: draft.type,
          side: draft.side,
          status: draft.status,
          datetime: draft.datetime,
          timeInForce: draft.timeInForce,
          filledPrice: filledPriceParam,
          filledAt: draft.filledAt,
          idempotencyKey: null,
        },
      });
      return { outcome: "CREATED", order: mapOrderRow(row) };
    }

    // Con key: INSERT ... ON CONFLICT DO NOTHING sobre
    // UNIQUE(userid, idempotencyKey). Count 1 ⇒ insertamos; 0 ⇒ conflicto
    // (otra orden YA reclamó esta key).
    const inserted = await db.$executeRaw`
      INSERT INTO orders
        ("instrumentid", "userid", "size", "price", "type", "side", "status",
         "datetime", "timeInForce", "filledPrice", "filledAt", "idempotencyKey")
      VALUES
        (${draft.instrumentId}, ${draft.userId}, ${draft.sizeShares}, ${priceParam},
         ${draft.type}, ${draft.side}, ${draft.status}, ${draft.datetime},
         ${draft.timeInForce}, ${filledPriceParam}, ${draft.filledAt},
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

    if (inserted === 1) {
      return { outcome: "CREATED", order: mapOrderRow(row) };
    }

    // Conflicto: ¿mismo PAYLOAD? (instrumentId/side/type/size/price/tif —
    // DECISIONS.md; status/filled* los decide la app, no integran el payload).
    const samePayload =
      row.instrumentId === draft.instrumentId &&
      row.side === draft.side &&
      row.type === draft.type &&
      row.timeInForce === draft.timeInForce &&
      row.size === draft.sizeShares &&
      this.pricesEqual(row.price, draft.priceArs);

    return {
      outcome: samePayload ? "IDEMPOTENT_REPLAY" : "IDEMPOTENT_CONFLICT",
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

  readonly findById = async (
    orderId: number,
    tx?: TransactionContext,
  ): Promise<OrderRecord | null> => {
    // Sin tx: lectura suelta del cancel (404 y dueño del lock, antes de
    // abrir la transacción). Con tx: la MISMA ventana de la transacción —
    // la relectura del 422 ve el status vigente al fallar el guard, no el
    // de una lectura previa que pudo quedar vieja.
    const db: DbExecutor = tx ? resolveDbExecutor(tx) : this.client;
    const row = await db.order.findUnique({ where: { id: orderId } });
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

  /** price de la fila vs price del draft (Decimal por string, nunca float). */
  private readonly pricesEqual = (
    dbValue: Prisma.Decimal | null,
    draftValue: Decimal | null,
  ): boolean => {
    if (dbValue === null || draftValue === null) {
      return dbValue === null && draftValue === null;
    }
    return decimalFromDb(dbValue).equals(draftValue);
  };
}
