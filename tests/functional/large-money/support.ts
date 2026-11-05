// Support de la suite de ACEPTACIÓN de grandes montos (spec D1–D5).
//
// DB REAL y AISLADA: `lm_acceptance_test` se deriva de TEST_DATABASE_URL y se
// recrea por suite con scripts/test-db-reset.sh (migrate deploy + seed
// intacto). Sólo esta suite escribe esa base.
//
// `DATABASE_URL` se fija ANTES de que se construya cualquier repositorio
// Prisma (el singleton es lazy) y se restaura al terminar, junto con el pool
// de asserts (pg) y el cliente Prisma.
//
// La app se compone con buildApp + TODOS los routers y repos Prisma REALES —
// mismo cableado que src/http/server.ts (que no se importa para no congelar
// el composition root de producción en el worker de test).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express } from "express";
import { Pool, type QueryResultRow } from "pg";
import { databaseUrlForTestName } from "../../helpers/test-database-url.js";
import { SEED_INSTRUMENT_ARS_ID } from "../../helpers/fixtures.js";
import { buildApp } from "../../../src/http/app.js";
import { buildCancelRouter } from "../../../src/http/cancel/cancel-router.js";
import { buildInstrumentsRouter } from "../../../src/http/instruments/instruments-router.js";
import { buildOrdersRouter } from "../../../src/http/orders/orders-router.js";
import { buildPortfolioRouter } from "../../../src/http/portfolio/portfolio-router.js";
import { buildTransfersRouter } from "../../../src/http/transfers/transfers-router.js";
import { PrismaInstrumentRepository } from "../../../src/infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../../../src/infra/prisma/marketdata-repository.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";
import { disconnectPrismaClient } from "../../../src/lib/prisma-client.js";
import type { OrderRepository } from "../../../src/domain/ports/index.js";
import type {
  CreateOrderResult,
  OrderDraft,
  OrderEventDraft,
  OrderEventRecord,
  OrderRecord,
  TransactionContext,
} from "../../../src/contracts/index.js";

const execFileAsync = promisify(execFile);

/** DB EXCLUSIVA de esta suite. */
export const LARGE_MONEY_DB_NAME = "lm_acceptance_test";
export const LARGE_MONEY_DB_URL = databaseUrlForTestName(LARGE_MONEY_DB_NAME);

const previousDatabaseUrl = process.env["DATABASE_URL"];
process.env["DATABASE_URL"] = LARGE_MONEY_DB_URL;

/** Reset aislado: nombre EXPLÍCITO vence cualquier TEST_DB_NAME heredado. */
export const resetLargeMoneyDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: LARGE_MONEY_DB_NAME },
  });
};

/**
 * App con el MISMO cableado que el composition root (5 routers + 4 repos
 * Prisma reales). `orders` permite inyectar el repositorio envuelto del test
 * de rollback; por defecto es el real.
 */
export const buildLargeMoneyTestApp = (
  orders: OrderRepository = new PrismaOrderRepository(),
): Express => {
  const portfolioRead = new PrismaPortfolioReadRepository();
  const instruments = new PrismaInstrumentRepository();
  const marketdata = new PrismaMarketdataRepository();
  return buildApp([
    buildPortfolioRouter({ portfolioRead, marketdata, instruments }),
    buildInstrumentsRouter({ instruments, marketdata }),
    buildOrdersRouter({ orders, portfolioRead, instruments, marketdata }),
    buildCancelRouter({ orders }),
    buildTransfersRouter({ orders, portfolioRead, instruments }),
  ]);
};

// ---------------------------------------------------------------------------
// pg directo (asserts de filas/eventos) — misma DB, otro pool
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: LARGE_MONEY_DB_URL, max: 2 });

/** Cierra pool + Prisma y restaura el env previo (worker limpio). */
export const closeLargeMoneyDatabase = async (): Promise<void> => {
  await pool.end();
  await disconnectPrismaClient();
  if (previousDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = previousDatabaseUrl;
  }
};

const dbQuery = async <T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> => (await pool.query<T>(text, [...values])).rows;

export interface LargeMoneyOrderRow {
  readonly id: number;
  readonly userid: number | null;
  readonly side: string | null;
  readonly status: string | null;
  readonly size: string | null;
  readonly price: string | null;
  readonly "filledPrice": string | null;
  readonly "idempotencyKey": string | null;
}

export const fetchOrderRow = async (
  orderId: number,
): Promise<LargeMoneyOrderRow | undefined> =>
  (
    await dbQuery<LargeMoneyOrderRow>(
      `SELECT id, userid, side, status, size, price, "filledPrice", "idempotencyKey"
         FROM orders WHERE id = $1`,
      [orderId],
    )
  )[0];

export interface LargeMoneyOrderEventRow {
  readonly eventType: string;
  readonly reason: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export const fetchOrderEvents = async (
  orderId: number,
): Promise<LargeMoneyOrderEventRow[]> =>
  dbQuery<LargeMoneyOrderEventRow>(
    `SELECT "eventType", reason, metadata
       FROM order_events WHERE orderid = $1 ORDER BY id ASC`,
    [orderId],
  );

export const countOrdersForUser = async (userId: number): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM orders WHERE userid = $1",
    [userId],
  );
  return rows[0]?.count ?? 0;
};

export const countEventsForUser = async (userId: number): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM order_events e JOIN orders o ON o.id = e.orderid
      WHERE o.userid = $1`,
    [userId],
  );
  return rows[0]?.count ?? 0;
};

export const countOrdersWithIdempotencyKey = async (
  userId: number,
  idempotencyKey: string,
): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM orders
      WHERE userid = $1 AND "idempotencyKey" = $2`,
    [userId, idempotencyKey],
  );
  return rows[0]?.count ?? 0;
};

export const countAllOrders = async (): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM orders",
  );
  return rows[0]?.count ?? 0;
};

export const countAllEvents = async (): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM order_events",
  );
  return rows[0]?.count ?? 0;
};

export const insertTestUser = async (email: string): Promise<number> => {
  const rows = await dbQuery<{ id: number }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("INSERT de users no devolvió id (fixture rota).");
  }
  return id;
};

// ---------------------------------------------------------------------------
// Fixtures HISTÓRICAS de cash (fila + evento de origen en la MISMA tx)
// ---------------------------------------------------------------------------

export interface HistoricalCashFixture {
  readonly userId: number;
  /** Columna física `size`: 123 para la era floor, 0 para ZERO_SIZE. */
  readonly storedAmount: string;
  readonly status: "FILLED" | "REJECTED";
  readonly idempotencyKey: string;
  /** metadata del evento de ORIGEN; null lo deja ausente. */
  readonly metadata: Record<string, unknown> | null;
  readonly eventType: "ACCEPTED" | "REJECTED";
  readonly reason: "ZERO_SIZE" | null;
}

/**
 * Inserta la fila cash histórica y su evento de origen en UNA transacción
 * (misma disciplina que la API, sin repos ni mocks). Precio unitario 1.00.
 */
export const insertHistoricalCash = async (
  fixture: HistoricalCashFixture,
): Promise<number> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO orders
         (instrumentid, userid, side, type, status, size, price,
          "filledPrice", "filledAt", datetime, "timeInForce", "idempotencyKey")
       VALUES ($1, $2, 'CASH_IN', 'MARKET', $3, $4, '1.00',
               $5, $6, now(), 'GTC', $7)
       RETURNING id`,
      [
        SEED_INSTRUMENT_ARS_ID,
        fixture.userId,
        fixture.status,
        fixture.storedAmount,
        fixture.status === "FILLED" ? "1.00" : null,
        fixture.status === "FILLED" ? new Date() : null,
        fixture.idempotencyKey,
      ],
    );
    const orderId = inserted.rows[0]?.id;
    if (orderId === undefined) {
      throw new Error("INSERT de orders histórica no devolvió id.");
    }
    await client.query(
      `INSERT INTO order_events ("orderid", "eventType", reason, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        orderId,
        fixture.eventType,
        fixture.reason,
        fixture.metadata === null ? null : JSON.stringify(fixture.metadata),
      ],
    );
    await client.query("COMMIT");
    return orderId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Rollback REAL: repo envuelto que delega y falla DESPUÉS del evento
// ---------------------------------------------------------------------------

/**
 * Implementa el port delegando TODO al repositorio Prisma real, salvo que
 * `appendOrderEvent` revienta después de insertar el evento. La transacción
 * (advisory lock incluido) es la real: el throw debe revertir orden + evento.
 */
export class FailingAuditOrderRepository implements OrderRepository {
  constructor(private readonly delegate: OrderRepository) {}

  withUserTransaction<T>(
    userId: number,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.delegate.withUserTransaction(userId, operation);
  }

  createOrder(
    draft: OrderDraft,
    tx: TransactionContext,
  ): Promise<CreateOrderResult> {
    return this.delegate.createOrder(draft, tx);
  }

  async appendOrderEvent(
    event: OrderEventDraft,
    tx: TransactionContext,
  ): Promise<OrderEventRecord> {
    await this.delegate.appendOrderEvent(event, tx);
    throw new Error("fallo de auditoría inyectado (rollback E2E)");
  }

  findById(
    orderId: number,
    tx?: TransactionContext,
  ): Promise<OrderRecord | null> {
    return this.delegate.findById(orderId, tx);
  }

  markFilled(
    orderId: number,
    filledPriceArs: Parameters<OrderRepository["markFilled"]>[1],
    filledAt: Date,
    tx: TransactionContext,
  ): Promise<OrderRecord | null> {
    return this.delegate.markFilled(orderId, filledPriceArs, filledAt, tx);
  }

  markCancelled(
    orderId: number,
    tx: TransactionContext,
  ): Promise<OrderRecord | null> {
    return this.delegate.markCancelled(orderId, tx);
  }
}
