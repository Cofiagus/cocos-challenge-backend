// Célula D — acceso directo a la DB de los tests funcionales de UC-3.
//
// La suite de orders deriva su URL desde TEST_DATABASE_URL y usa una base
// aislada de las demás suites. Nunca toma la URL runtime de la aplicación.
//
// Dinero (AGENTS.md): pg devuelve `numeric` como string; los asserts lo
// comparan vía Decimal construido desde strings, nunca float.

import { databaseUrlForTestName } from "../../helpers/test-database-url.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool, type QueryResultRow } from "pg";

const execFileAsync = promisify(execFile);

export const FUNCTIONAL_DB_NAME = "cocos_challenge_ftest";
export const FUNCTIONAL_DATABASE_URL = databaseUrlForTestName(FUNCTIONAL_DB_NAME);

/**
 * Recrea la DB de la célula D al estado del seed (migración versionada +
 * db/seed.sql), con los golden values verificados por el orquestador.
 * Fuerza TEST_DB_NAME=cocos_challenge_ftest para no tocar la DB de otra
 * célula aunque el entorno traiga otra variable.
 */
export const resetFunctionalDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DB_NAME: FUNCTIONAL_DB_NAME },
  });
};

const pool = new Pool({ connectionString: FUNCTIONAL_DATABASE_URL, max: 1 });

export const closeFunctionalDbPool = async (): Promise<void> => {
  await pool.end();
};

const dbQuery = async <T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> => (await pool.query<T>(text, values)).rows;

/** Fila de `orders` — columnas EXACTAS del schema migrado: las mapeadas con
 *  @map son lowercase; las nuevas de FASE 1 van SIN @map ⇒ camelCase (y en
 *  SQL hay que quoted-las porque Postgres foldea a minúsculas). */
export interface OrderRow {
  readonly id: number;
  readonly instrumentid: number | null;
  readonly userid: number | null;
  readonly size: number | null;
  readonly price: string | null;
  readonly type: string | null;
  readonly side: string | null;
  readonly status: string | null;
  readonly timeInForce: string;
  readonly filledPrice: string | null;
  readonly filledAt: Date | null;
  readonly idempotencyKey: string | null;
}

export const fetchOrderRow = async (
  orderId: number,
): Promise<OrderRow | undefined> =>
  (
    await dbQuery<OrderRow>(
      `SELECT id, instrumentid, userid, size, price, type, side, status,
              "timeInForce", "filledPrice", "filledAt", "idempotencyKey"
         FROM orders WHERE id = $1`,
      [orderId],
    )
  )[0];

/** Órdenes del usuario (para asserts de "no se creó nada"). */
export const countOrdersForUser = async (userId: number): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    "SELECT count(*)::int AS count FROM orders WHERE userid = $1",
    [userId],
  );
  return rows[0]?.count ?? 0;
};

/** Órdenes con una Idempotency-Key dada (UNIQUE(userid, idempotencyKey)). */
export const countOrdersWithIdempotencyKey = async (
  userId: number,
  idempotencyKey: string,
): Promise<number> => {
  const rows = await dbQuery<{ count: number }>(
    'SELECT count(*)::int AS count FROM orders WHERE userid = $1 AND "idempotencyKey" = $2',
    [userId, idempotencyKey],
  );
  return rows[0]?.count ?? 0;
};

/** Evento de auditoría de order_events (razones de rechazo/cancelación). */
export interface OrderEventRow {
  readonly eventType: string;
  readonly reason: string | null;
}

export const fetchOrderEvents = async (
  orderId: number,
): Promise<OrderEventRow[]> =>
  dbQuery<OrderEventRow>(
    'SELECT "eventType", reason FROM order_events WHERE orderid = $1 ORDER BY id ASC',
    [orderId],
  );