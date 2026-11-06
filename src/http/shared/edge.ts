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

/** Motivo del rechazo: header repetido (D-04) o valor fuera de forma. */
export type IdempotencyKeyHeaderRejection = "duplicated" | "invalid";

/** Lectura del header Idempotency-Key: válida con key (o null) o inválida. */
export type IdempotencyKeyHeader =
  | { readonly ok: true; readonly key: string | null }
  | { readonly ok: false; readonly reason: IdempotencyKeyHeaderRejection };

/**
 * Lo que el borde necesita para leer el Idempotency-Key: `headers` ya unido
 * por Node y `rawHeaders` con los pares nombre/valor TAL CUAL llegaron.
 */
export interface IdempotencyKeyHeaderSource {
  readonly headers: IncomingHttpHeaders;
  /**
   * Cabeceras crudas de Node (`[nombre, valor, ...]`): la ÚNICA forma de ver
   * un header repetido, porque `headers` une los duplicados con ", " en un
   * solo string (defecto D-04). Sin `rawHeaders` se mira el array de
   * `headers` (mocks/tests que no emulan Node).
   */
  readonly rawHeaders?: readonly string[];
}

/** Nombre del header en minúsculas: `rawHeaders` conserva el casing del cliente. */
const IDEMPOTENCY_KEY_HEADER_LOWER = IDEMPOTENCY_KEY_HEADER.toLowerCase();

/** Pares nombre/valor crudos: cuenta las veces que llegó el Idempotency-Key. */
const rawHeaderOccurrences = (rawHeaders: readonly string[]): number => {
  let occurrences = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (
      typeof name === "string" &&
      name.toLowerCase() === IDEMPOTENCY_KEY_HEADER_LOWER
    ) {
      occurrences += 1;
    }
  }
  return occurrences;
};

/** Veces que el request trae el header (rawHeaders manda; si no, el array). */
const idempotencyKeyOccurrences = (
  source: IdempotencyKeyHeaderSource,
): number => {
  if (source.rawHeaders !== undefined) {
    return rawHeaderOccurrences(source.rawHeaders);
  }
  const raw = source.headers[IDEMPOTENCY_KEY_HEADER];
  if (Array.isArray(raw)) return raw.length;
  return raw === undefined ? 0 : 1;
};

/**
 * Idempotency-Key del header (OPCIONAL): ausente ⇒ null; inválida
 * (no string / vacía / > 64) ⇒ `invalid`; repetida ⇒ `duplicated`. En los
 * dos rechazos el borde responde 400 SIN crear orden.
 *
 * D-04: dos headers con el mismo nombre NO se resuelven tomando el primero.
 * Node los une en `headers` como "a, b", una clave compuesta que el schema
 * (1..64) acepta: se detectan contando `rawHeaders`, antes de mirar el valor.
 */
export const parseIdempotencyKeyHeader = (
  source: IdempotencyKeyHeaderSource,
): IdempotencyKeyHeader => {
  if (idempotencyKeyOccurrences(source) > 1) {
    return { ok: false, reason: "duplicated" };
  }
  const raw = source.headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return { ok: true, key: null };
  }
  const parsed = IdempotencyKeySchema.safeParse(value);
  return parsed.success
    ? { ok: true, key: parsed.data }
    : { ok: false, reason: "invalid" };
};

/** Lo que el borde lee de un request: sin Express (puro y testeable). */
export interface WriteRequestSource extends IdempotencyKeyHeaderSource {
  readonly params: unknown;
  readonly body: unknown;
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

/** Mensaje del 400 por header rechazado (una forma por motivo). */
const idempotencyKeyRejectionMessage = (
  reason: IdempotencyKeyHeaderRejection,
): string =>
  reason === "duplicated"
    ? `Header ${IDEMPOTENCY_KEY_HEADER} repetido: se acepta un único header de 1..64 caracteres.`
    : `Header ${IDEMPOTENCY_KEY_HEADER} inválido: se espera string de 1..64 caracteres.`;

/** Idempotency-Key del header, o null cuando la ruta no la admite. */
const readWriteHeader = (
  source: WriteRequestSource,
  enabled: boolean | undefined,
): IdempotencyKeyHeader =>
  enabled === true
    ? parseIdempotencyKeyHeader(source)
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

  const header = readWriteHeader(req, schemas.header);
  if (!header.ok) {
    return invalidRequest(idempotencyKeyRejectionMessage(header.reason));
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
/** Prisma: no se puede alcanzar el servidor (host/puerto/DNS). */
const PRISMA_CANNOT_REACH_DATABASE = "P1001";
/** Prisma: la operación excedió el tiempo máximo del servidor. */
const PRISMA_OPERATION_TIMEOUT = "P1008";
/** Prisma: el servidor cerró la conexión en medio de la operación. */
const PRISMA_CONNECTION_CLOSED = "P1017";
/** SQLSTATE de `admin_shutdown`: el servidor se apaga y corta las conexiones. */
const SQLSTATE_ADMIN_SHUTDOWN = "57P01";
/** Clase 08 de SQLSTATE = connection_exception (`08006`, `08P01`, ...). */
const SQLSTATE_CONNECTION_EXCEPTION_PREFIX = "08";
/** Longitud de un SQLSTATE (`57014`, `08P01`): descarta prefijos sueltos. */
const SQLSTATE_LENGTH = 5;

/** Códigos que significan "la base no me atendió", no "el pedido está mal". */
const CONTENTION_CODES: ReadonlySet<string> = new Set([
  SQLSTATE_QUERY_CANCELED,
  PRISMA_TRANSACTION_TIMEOUT,
  PRISMA_POOL_TIMEOUT,
  SOCKET_CONNECT_TIMEOUT,
]);

/**
 * Códigos que significan "la base no está" (antes del `code`, red caída, DNS,
 * servidor apagándose): reintentables igual que la contención, pero el fallo
 * no depende de la carga ni de la query.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  PRISMA_CANNOT_REACH_DATABASE,
  PRISMA_OPERATION_TIMEOUT,
  PRISMA_CONNECTION_CLOSED,
  SQLSTATE_ADMIN_SHUTDOWN,
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

/**
 * Textos de Prisma/`pg` que delatan una base inalcanzable o un cierre abrupto
 * de la conexión. Son específicos de PostgreSQL: no matchean errores de otros
 * proveedores (p. ej. el fetch de cotizaciones).
 */
const UNREACHABLE_MESSAGES: readonly RegExp[] = [
  /can't reach database server/i,
  /connection terminated unexpectedly/i,
  /server closed the connection unexpectedly/i,
];

/** Señales de una clase de falla de la base: el `code` y/o el texto. */
interface DatabaseFailureSignals {
  readonly matchesCode: (code: string) => boolean;
  readonly messages: readonly RegExp[];
}

/** ¿El código es de la clase 08 (connection_exception) o `57P01`? */
const isUnreachableCode = (code: string): boolean =>
  UNREACHABLE_CODES.has(code) ||
  (code.length === SQLSTATE_LENGTH &&
    code.startsWith(SQLSTATE_CONNECTION_EXCEPTION_PREFIX));

/** Base inalcanzable: no hay servidor del otro lado (o se está apagando). */
const UNREACHABLE_SIGNALS: DatabaseFailureSignals = {
  matchesCode: isUnreachableCode,
  messages: UNREACHABLE_MESSAGES,
};

/**
 * Contención: la base está, pero no atendió a tiempo. Incluye la base
 * inalcanzable porque las dos son el MISMO 503 reintentable (el mensaje las
 * distingue); `isDatabaseUnreachableError` es el predicado más específico.
 */
const CONTENTION_SIGNALS: DatabaseFailureSignals = {
  matchesCode: (code) => CONTENTION_CODES.has(code) || isUnreachableCode(code),
  messages: CONTENTION_MESSAGES,
};

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

/** ¿El código o el texto del objeto delatan esta clase de falla? */
const signalsFailure = (
  value: Record<string, unknown>,
  signals: DatabaseFailureSignals,
): boolean => {
  const code = errorCode(value);
  if (code !== null && signals.matchesCode(code)) return true;
  const message = errorMessage(value);
  return signals.messages.some((pattern) => pattern.test(message));
};

const containsFailure = (
  error: unknown,
  signals: DatabaseFailureSignals,
  depth: number,
): boolean => {
  if (typeof error === "string") {
    return signals.messages.some((pattern) => pattern.test(error));
  }
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (signalsFailure(record, signals)) return true;
  if (depth >= MAX_CAUSE_DEPTH) return false;
  return (
    containsFailure(record["cause"], signals, depth + 1) ||
    containsFailure(record["meta"], signals, depth + 1)
  );
};

/**
 * ¿La base es INALCANZABLE? P1001 (no se puede llegar al servidor), P1008
 * (timeout de operación), P1017 (el servidor cerró la conexión), SQLSTATE de
 * la clase 08 (`connection_exception`: `08006`, `08P01`, ...) y `57P01`
 * (`admin_shutdown`). Con una base remota un corte de red, un DNS que no
 * resuelve o un failover caen acá: el pedido es válido y reintentar tiene
 * sentido ⇒ 503, nunca 500.
 *
 * Prisma envuelve el SQLSTATE de un `$executeRaw` en `P2010` con
 * `meta: { code: "08006" }`, por eso se recorre `meta` y `cause` igual que en
 * la contención.
 */
export const isDatabaseUnreachableError = (error: unknown): boolean =>
  containsFailure(error, UNREACHABLE_SIGNALS, 0);

/**
 * ¿Es una falla TEMPORAL de la base (contención o base inalcanzable)? El
 * pedido es válido y la base no lo atendió: `statement_timeout` (SQLSTATE
 * 57014 — el que dispara esperar el advisory lock con el `statement_timeout`
 * de src/lib/prisma-client), transacción abortada por Prisma (P2028), pool
 * agotado (P2024), timeout de conexión (`ETIMEDOUT` o el mensaje de pg-pool)
 * y toda la clase de base inalcanzable (`isDatabaseUnreachableError`).
 * Reintentable ⇒ 503.
 *
 * Prisma envuelve el SQLSTATE de un `$executeRaw` en `P2010` con
 * `meta: { code: "57014" }`, por eso se recorre `meta` y `cause`.
 */
export const isTemporaryContentionError = (error: unknown): boolean =>
  containsFailure(error, CONTENTION_SIGNALS, 0);

/** Mensaje del 503 cuando la base está: simplemente no atendió a tiempo. */
const DATABASE_SATURATED_MESSAGE =
  "La base de datos está momentáneamente saturada. Reintentá en unos segundos.";

/** Mensaje del 503 cuando no hay base del otro lado (red, DNS, apagado). */
const DATABASE_UNREACHABLE_MESSAGE =
  "La base de datos no está disponible. Reintentá en unos segundos.";

/**
 * 503 del contrato para una falla temporal de la base (defecto D-03): el
 * código es propio y el status nunca 500, porque reintentar el pedido lo
 * resuelve. La cabecera `Retry-After` la emite el manejador central.
 *
 * `kind` distingue la causa en el MENSAJE (misma familia de status/código):
 * "unreachable" cuando no se llega al servidor, "contention" cuando la base
 * está pero no atendió. Sin argumento se emite el mensaje de contención, que
 * es el que documenta `openapi.json`.
 */
export const databaseUnavailableError = (
  kind: "contention" | "unreachable" = "contention",
): HttpError => ({
  status: 503,
  code: API_ERROR_CODES.DATABASE_UNAVAILABLE,
  message:
    kind === "unreachable"
      ? DATABASE_UNREACHABLE_MESSAGE
      : DATABASE_SATURATED_MESSAGE,
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
