// Borde HTTP compartido por los routers: funciones puras (sin Express) que
// validan la entrada de las rutas de ESCRITURA (params + body +
// Idempotency-Key), traducen errores de aplicación al contrato HTTP y
// serializan filas persistidas al contrato.
//
// El texto viaja en el body de los 400 y los campos del OrderResponse son los
// del contrato: cambiarlos cambia la respuesta de la API.
//
// D3 (spec grandes montos): `size` está discriminado por `side` — BUY/SELL lo
// emiten como number entero (o null), CASH_IN/CASH_OUT como string monetario
// de 2 decimales (`serializeMoneyArs`), sin bigint crudo ni notación
// científica. Precios y fechas conservan sus nulls.

import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import {
  API_ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  apiErrorBody,
  serializeLocalTimestamp,
  serializeMoneyArs,
  type ApiErrorBody,
  type ApiErrorCode,
  type OrderRecord,
  type OrderRejectionReason,
  type OrderResponse,
} from "../../contracts/index.js";
import { SubmitOrderError } from "../../application/orders/submit-order.js";
import { SubmitTransferError } from "../../application/transfers/submit-transfer.js";
import { CancelOrderError } from "../../application/cancel/cancel-order.js";
import { IdempotencyConflictError } from "../../application/orders/persist-order-decision.js";

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
export const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

/** Lectura del header Idempotency-Key: válida con key (o null) o inválida. */
export type IdempotencyKeyHeader =
  | { readonly ok: true; readonly key: string | null }
  | { readonly ok: false };

/**
 * Idempotency-Key del header (OPCIONAL): ausente ⇒ null; inválida
 * (no string / vacía / > 64) ⇒ invalid, y el borde responde 400 SIN crear
 * orden. Un header repetido llega como array: manda el primero.
 */
export const parseIdempotencyKeyHeader = (
  headers: IncomingHttpHeaders,
): IdempotencyKeyHeader => {
  const raw = headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return { ok: true, key: null };
  }
  const parsed = IdempotencyKeySchema.safeParse(value);
  return parsed.success ? { ok: true, key: parsed.data } : { ok: false };
};

/** Lo que el borde lee de un request: sin Express (puro y testeable). */
export interface WriteRequestSource {
  readonly params: unknown;
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
}

/** Lo único que el borde necesita de un schema: `safeParse` tipado. */
interface InputSchema<T> {
  safeParse(value: unknown): z.ZodSafeParseResult<T>;
}

/**
 * Schemas del borde de una ruta de escritura. `body` falta en las rutas sin
 * body (DELETE) y `header` habilita la lectura del Idempotency-Key (sólo las
 * rutas de creación: en las demás ni se mira).
 */
export interface WriteRequestSchemas<P, B> {
  readonly params: InputSchema<P>;
  readonly body?: InputSchema<B>;
  readonly header?: boolean;
}

/**
 * Request ya validado en el borde, o el body del 400 que corresponde.
 * `params`/`body` salen del schema (ya tipados): el router no re-valida nada.
 */
export type ParsedWriteRequest<P, B> =
  | {
      readonly ok: true;
      readonly params: P;
      readonly body: B;
      readonly idempotencyKey: string | null;
    }
  | { readonly ok: false; readonly error: ApiErrorBody };

/** 400 VALIDATION_ERROR: el ÚNICO status del borde (no crea ni muta nada). */
const invalidRequest = (message: string): { readonly ok: false; readonly error: ApiErrorBody } => ({
  ok: false,
  error: apiErrorBody(API_ERROR_CODES.VALIDATION_ERROR, message),
});

/** Idempotency-Key del header, o null cuando la ruta no la admite. */
const readWriteHeader = (
  headers: IncomingHttpHeaders,
  enabled: boolean | undefined,
): IdempotencyKeyHeader =>
  enabled === true
    ? parseIdempotencyKeyHeader(headers)
    : { ok: true, key: null };

/**
 * Borde de una ruta de ESCRITURA: params de ruta y body con Zod estricto y,
 * si la ruta lo admite, el Idempotency-Key opcional — en ese orden. Cualquier
 * fallo ⇒ 400 VALIDATION_ERROR SIN tocar la DB.
 */
export function parseWriteRequest<P, B = undefined>(
  req: WriteRequestSource,
  schemas: {
    readonly params: InputSchema<P>;
    readonly body?: InputSchema<B>;
    readonly header?: boolean;
  },
): ParsedWriteRequest<P, B>;
export function parseWriteRequest(
  req: WriteRequestSource,
  schemas: WriteRequestSchemas<unknown, unknown>,
): ParsedWriteRequest<unknown, unknown> {
  const params = schemas.params.safeParse(req.params);
  if (!params.success) {
    return invalidRequest(
      `Parámetros inválidos: ${validationMessage(params.error)}`,
    );
  }

  const header = readWriteHeader(req.headers, schemas.header);
  if (!header.ok) {
    return invalidRequest(
      `Header ${IDEMPOTENCY_KEY_HEADER} inválido: se espera string de 1..64 caracteres.`,
    );
  }

  const body = schemas.body?.safeParse(req.body);
  if (body !== undefined && !body.success) {
    return invalidRequest(`Body inválido: ${validationMessage(body.error)}`);
  }

  return {
    ok: true,
    params: params.data,
    body: body?.data,
    idempotencyKey: header.key,
  };
}

/** Error de aplicación ya traducido al contrato HTTP. */
export interface HttpError {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
}

/** Cabecera del 503 reintentable: segundos que el cliente debe esperar. */
export const RETRY_AFTER_HEADER = "Retry-After";

/** Segundos de `Retry-After` de una falla temporal de la base. */
export const RETRY_AFTER_SECONDS = 2;

/** SQLSTATE de `statement_timeout`: la sentencia se canceló por tiempo. */
const SQLSTATE_QUERY_CANCELED = "57014";
/** Prisma: la transacción interactiva se abortó por timeout del servidor. */
const PRISMA_TRANSACTION_TIMEOUT = "P2028";
/** Prisma: el pool no entregó una conexión dentro del `maxWait`. */
const PRISMA_POOL_TIMEOUT = "P2024";
/** Node/pg: la conexión TCP al servidor no se estableció a tiempo. */
const SOCKET_CONNECT_TIMEOUT = "ETIMEDOUT";

/** Códigos que significan "la base no me atendió", no "el pedido está mal". */
const CONTENTION_CODES: ReadonlySet<string> = new Set([
  SQLSTATE_QUERY_CANCELED,
  PRISMA_TRANSACTION_TIMEOUT,
  PRISMA_POOL_TIMEOUT,
  SOCKET_CONNECT_TIMEOUT,
]);

/**
 * Timeouts de `pg`/`pg-pool` que llegan SIN `code`: el pool aborta con un
 * `Error` pelado al vencer `connectionTimeoutMillis`, y el driver puede dejar
 * el SQLSTATE sólo en el texto.
 */
const CONTENTION_MESSAGES: readonly RegExp[] = [
  /canceling statement due to statement timeout/i,
  /timeout exceeded when trying to connect/i,
  /connection terminated due to connection timeout/i,
];

/** Profundidad máxima al seguir `cause`/`meta` (Prisma anida 2–3 niveles). */
const MAX_CAUSE_DEPTH = 3;

/** `code` del error (pg/Prisma), o null si no lo trae como string. */
const errorCode = (value: Record<string, unknown>): string | null => {
  const code = value["code"];
  return typeof code === "string" ? code : null;
};

/** Texto del error (vacío cuando el objeto no trae `message`). */
const errorMessage = (value: Record<string, unknown>): string => {
  const message = value["message"];
  return typeof message === "string" ? message : "";
};

/** ¿El código o el texto del objeto delatan contención de la base? */
const signalsContention = (value: Record<string, unknown>): boolean => {
  const code = errorCode(value);
  if (code !== null && CONTENTION_CODES.has(code)) return true;
  const message = errorMessage(value);
  return CONTENTION_MESSAGES.some((pattern) => pattern.test(message));
};

const containsContention = (error: unknown, depth: number): boolean => {
  if (typeof error === "string") {
    return CONTENTION_MESSAGES.some((pattern) => pattern.test(error));
  }
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (signalsContention(record)) return true;
  if (depth >= MAX_CAUSE_DEPTH) return false;
  return (
    containsContention(record["cause"], depth + 1) ||
    containsContention(record["meta"], depth + 1)
  );
};

/**
 * ¿Es contención/saturación de PostgreSQL? El pedido es válido y la base no lo
 * atendió a tiempo: `statement_timeout` (SQLSTATE 57014 — el que dispara
 * esperar el advisory lock con el `statement_timeout` de src/lib/prisma-client),
 * transacción abortada por Prisma (P2028), pool agotado (P2024) y timeout de
 * conexión (`ETIMEDOUT` o el mensaje de pg-pool). Reintentable ⇒ 503.
 *
 * Prisma envuelve el SQLSTATE de un `$executeRaw` en `P2010` con
 * `meta: { code: "57014" }`, por eso se recorre `meta` y `cause`.
 */
export const isTemporaryContentionError = (error: unknown): boolean =>
  containsContention(error, 0);

/** Mensaje del 503: sin host, puerto ni SQLSTATE (no es canal de diagnóstico). */
const DATABASE_UNAVAILABLE_MESSAGE =
  "La base de datos está momentáneamente saturada. Reintentá en unos segundos.";

/**
 * 503 del contrato para una falla temporal de la base (defecto D-03): el
 * código es propio y el status nunca 500, porque reintentar el pedido lo
 * resuelve. La cabecera `Retry-After` la emite el manejador central.
 */
export const databaseUnavailableError = (): HttpError => ({
  status: 503,
  code: API_ERROR_CODES.DATABASE_UNAVAILABLE,
  message: DATABASE_UNAVAILABLE_MESSAGE,
});

/**
 * Error de aplicación → status + código + mensaje del contrato. null cuando
 * el error NO es de dominio: el router lo propaga al manejador central, que
 * responde 503 + `Retry-After` si es contención de la base
 * (`isTemporaryContentionError`) o 500 INTERNAL_ERROR en cualquier otro caso.
 * La contención se resuelve en el manejador y no acá para que el 503 salga
 * con su cabecera por un único camino (los routers arman la respuesta a mano).
 */
export const toHttpError = (error: unknown): HttpError | null => {
  if (
    error instanceof SubmitOrderError ||
    error instanceof SubmitTransferError ||
    error instanceof CancelOrderError ||
    error instanceof IdempotencyConflictError
  ) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return null;
};

/** Campos del OrderResponse que NO cambian con el side (IDs, precios, fechas). */
const orderResponseCommon = (order: OrderRecord, reason: OrderRejectionReason | null) => {
  // El mapper de infra ya falla ruidosamente ante un NULL acá: este
  // estrechamiento es sólo de tipos (inalcanzable en runtime).
  if (order.instrumentId === null) {
    throw new Error("Orden persistida sin instrumentId (inalcanzable).");
  }
  return {
    id: order.id,
    instrumentId: order.instrumentId,
    type: order.type,
    timeInForce: order.timeInForce,
    status: order.status,
    price: order.priceArs === null ? null : serializeMoneyArs(order.priceArs),
    filledPrice:
      order.filledPriceArs === null
        ? null
        : serializeMoneyArs(order.filledPriceArs),
    filledAt:
      order.filledAt === null ? null : serializeLocalTimestamp(order.filledAt),
    datetime: serializeLocalTimestamp(order.datetime),
    reason,
  };
};

/** Fila persistida + razón de rechazo/cancelación → OrderResponse del contrato. */
export const toOrderResponse = (
  order: OrderRecord,
  reason: OrderRejectionReason | null,
): OrderResponse => {
  const common = orderResponseCommon(order, reason);
  if (order.side === "BUY" || order.side === "SELL") {
    return { ...common, side: order.side, size: order.sizeShares };
  }
  // Cash: la columna física `size` es un monto en ARS; se emite como string
  // canónico de 2 decimales (un size histórico de 123 ⇒ "123.00").
  return {
    ...common,
    side: order.side,
    size: serializeMoneyArs(order.amountArs),
  };
};
