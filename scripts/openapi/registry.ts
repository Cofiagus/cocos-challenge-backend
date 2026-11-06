// Registro declarativo de las 5 operaciones de la API — la entrada del generador de OpenAPI.
//
// Una operación = método + ruta de Express + schemas Zod (params/query/header/body/respuestas) +
// códigos de error + ejemplo real. Es la ÚNICA lista de rutas de la documentación: el test
// `tests/docs/openapi.test.ts` compara este registro contra los `router.<verbo>("...")` de
// `src/http/**`, y falla si divergen.
//
// Los ejemplos son respuestas capturadas de la API sobre una base recién sembrada: si un
// ejemplo no se puede reproducir contra el servidor, se borra.

import { z } from "zod";
import {
  ApiErrorBodySchema,
  CancelOrderParamsSchema,
  CreateOrderParamsSchema,
  CreateTransferParamsSchema,
  IdempotencyKeySchema,
  InstrumentSearchQuerySchema,
  InstrumentSearchResponseSchema,
  OrderResponseSchema,
  PortfolioParamsSchema,
  PortfolioResponseSchema,
} from "../../src/contracts/index.js";
import {
  CreateOrderBodySchema,
  CreateTransferBodySchema,
} from "./wire.js";

/** Códigos de error que la API puede devolver (los estables de `API_ERROR_CODES`). */
export const KNOWN_ERROR_CODES = [
  "VALIDATION_ERROR",
  "INSTRUMENT_NOT_OPERABLE",
  "USER_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "INSTRUMENT_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "ORDER_NOT_CANCELLABLE",
  "MARKET_DATA_SERVICE_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "NOT_FOUND",
  "INVALID_JSON",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export interface ResponseDoc {
  readonly status: number;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly example?: unknown;
  /** Cabeceras de la respuesta (p. ej. `Retry-After` del 503 reintentable). */
  readonly headers?: readonly ResponseHeaderDoc[];
}

export interface ResponseHeaderDoc {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
}

export interface OperationDoc {
  /** Path tal como lo declara Express (con `:param`), SIN el prefijo de montaje. */
  readonly expressPath: string;
  /**
   * `false` en las operaciones que la app NO monta bajo `/api`: los probes de
   * infraestructura viven en la raíz (`createServerApp` los monta fuera de
   * `buildApp`), así que el generador publica su path tal cual. Publicarlos con
   * el prefijo documentaría rutas que la app responde con 404. Default: `true`.
   */
  readonly mountedUnderApiPrefix?: boolean;
  readonly method: "get" | "post" | "delete";
  readonly summary: string;
  readonly description: string;
  readonly params?: z.ZodTypeAny;
  readonly query?: z.ZodTypeAny;
  /** `Idempotency-Key` opcional. */
  readonly idempotencyHeader?: boolean;
  /**
   * `false` en los probes: no dejan que una falla de la base llegue al
   * manejador central, así que su 503 (si existe) es otro contrato —
   * readiness responde `{status,database}`. Default: `true`.
   */
  readonly propagatesDatabaseErrors?: boolean;
  readonly body?: z.ZodTypeAny;
  readonly responses: readonly ResponseDoc[];
  readonly errorCodes: readonly KnownErrorCode[];
}

/**
 * Respuesta de error: el schema es el del contrato, el ejemplo fija el `code` estable y el
 * `message` es el que la API devuelve para ese caso.
 */
const errorBody = (
  status: number,
  code: KnownErrorCode,
  description: string,
  message: string,
  headers?: readonly ResponseHeaderDoc[],
): ResponseDoc => ({
  status,
  description: `${description} Código: \`${code}\`.`,
  schema: ApiErrorBodySchema,
  example: { error: { code, message } },
  ...(headers === undefined ? {} : { headers }),
});

interface TransversalError {
  readonly code: KnownErrorCode;
  readonly response: ResponseDoc;
}

/**
 * 503 reintentable por contención/saturación de PostgreSQL (defecto D-03):
 * `statement_timeout` (57014), P2028, P2024, `ETIMEDOUT` y el timeout del pool.
 * Lo responde el manejador central con `Retry-After`, así que existe en toda
 * operación cuyo handler lo deja propagar (las 5 de negocio; no en los probes).
 */
const DATABASE_ERRORS: readonly TransversalError[] = [
  {
    code: "DATABASE_UNAVAILABLE",
    response: errorBody(
      503,
      "DATABASE_UNAVAILABLE",
      "La base no atendió el pedido a tiempo (contención del pool, `statement_timeout` o timeout de conexión): el pedido es válido y se puede reintentar.",
      "La base de datos está momentáneamente saturada. Reintentá en unos segundos.",
      [
        {
          name: "Retry-After",
          description: "Segundos que el cliente debe esperar antes de reintentar.",
          schema: z.number().int(),
        },
      ],
    ),
  },
];

/**
 * Errores que no dependen de la operación: los agrega `withTransversalErrors` a TODAS, así
 * las responses y los `errorCodes` no pueden quedar desalineados.
 */
const TRANSVERSAL_ERRORS: readonly TransversalError[] = [
  {
    code: "NOT_FOUND",
    response: errorBody(
      404,
      "NOT_FOUND",
      "Ruta o método inexistente: método no soportado en esta ruta: el servidor responde 404, no 405.",
      "Ruta inexistente.",
    ),
  },
  {
    code: "INTERNAL_ERROR",
    response: errorBody(
      500,
      "INTERNAL_ERROR",
      "Error inesperado; el detalle queda en el log del servidor y el cliente recibe un mensaje genérico.",
      "Error interno del servidor.",
    ),
  },
];

/** Errores de `express.json()`: sólo existen en las operaciones con body. */
const BODY_TRANSVERSAL_ERRORS: readonly TransversalError[] = [
  {
    code: "INVALID_JSON",
    response: errorBody(
      400,
      "INVALID_JSON",
      "El body no parsea como JSON.",
      "El body no es JSON válido.",
    ),
  },
  {
    code: "PAYLOAD_TOO_LARGE",
    response: errorBody(
      413,
      "PAYLOAD_TOO_LARGE",
      "El body supera el límite de 100 KB.",
      "El body supera el límite de 100 KB.",
    ),
  },
];

/** Agrega a la operación los errores transversales (y los de body si tiene body). */
const withTransversalErrors = (operation: OperationDoc): OperationDoc => {
  const transversal = [
    ...TRANSVERSAL_ERRORS,
    ...(operation.propagatesDatabaseErrors === false ? [] : DATABASE_ERRORS),
    ...(operation.body === undefined ? [] : BODY_TRANSVERSAL_ERRORS),
  ];
  return {
    ...operation,
    responses: [
      ...operation.responses,
      ...transversal.map((entry) => entry.response),
    ],
    errorCodes: [
      ...operation.errorCodes,
      ...transversal.map((entry) => entry.code),
    ],
  };
};

/** Liveness: no toca la DB; siempre 200 mientras el proceso responda. */
const HealthResponseSchema = z.object({ status: z.literal("ok") });

/** Readiness: 200 si el `SELECT 1` responde, 503 si la base no está disponible. */
const ReadyResponseSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  database: z.enum(["up", "down"]),
});

const OPERATION_DEFINITIONS: readonly OperationDoc[] = [
  {
    expressPath: "/health",
    // Probe de infraestructura: se sirve en la raíz, NO bajo /api.
    mountedUnderApiPrefix: false,
    method: "get",
    summary: "Liveness",
    description:
      "El proceso está vivo. No consulta la base de datos: responde 200 mientras el servidor " +
      "atienda, y es el probe que usa el orquestador para no matar un arranque lento.",
    propagatesDatabaseErrors: false,
    responses: [
      {
        status: 200,
        description: "Proceso vivo (no implica base disponible).",
        schema: HealthResponseSchema,
        example: { status: "ok" },
      },
    ],
    errorCodes: [],
  },
  {
    expressPath: "/health/ready",
    // Probe de infraestructura: se sirve en la raíz, NO bajo /api.
    mountedUnderApiPrefix: false,
    method: "get",
    summary: "Readiness",
    description:
      "El proceso puede servir tráfico: ejecuta `SELECT 1` contra la base. 200 con " +
      "`database: \"up\"`; 503 con `database: \"down\"` si la base no responde dentro del " +
      "timeout del pool. Es el probe para sacar la instancia de rotación, no para reiniciarla.",
    // El 503 de readiness lo responde el propio probe con `{status,database}`, no el
    // manejador central: documentar acá DATABASE_UNAVAILABLE pisaría ese body.
    propagatesDatabaseErrors: false,
    responses: [
      {
        status: 200,
        description: "Base disponible.",
        schema: ReadyResponseSchema,
        example: { status: "ready", database: "up" },
      },
      {
        status: 503,
        description: "Base no disponible: la instancia no debe recibir tráfico.",
        schema: ReadyResponseSchema,
        example: { status: "unavailable", database: "down" },
      },
    ],
    errorCodes: [],
  },
  {
    expressPath: "/users/:userId/portfolio",
    method: "get",
    summary: "Portfolio de un usuario",
    description:
      "Proyección de `orders`: `cash` = settled − reservado por órdenes `NEW` de compra; " +
      "`totalAccountValue` = `cash` + `reservedCash` + Σ `marketValue` de las posiciones con " +
      "precio (abrir o cancelar una orden no lo mueve). Posiciones con cantidad 0 no se " +
      "listan; sin precio de referencia `marketValue` es `null` y la posición no suma al " +
      "total. `MONEDA` nunca aparece. El dinero viaja como string con exactamente 2 decimales " +
      "y `quantity` como string entero canónico (D3; los agregados pueden superar el máximo " +
      "de una fila).",
    params: PortfolioParamsSchema,
    responses: [
      {
        status: 200,
        description: "Portfolio derivado (usuario 1 del seed).",
        schema: PortfolioResponseSchema,
        example: {
          cash: "627500.00",
          reservedCash: "125500.00",
          totalAccountValue: "889756.00",
          positions: [
            {
              ticker: "BMA",
              name: "Banco Macro S.A.",
              quantity: "-10",
              marketValue: "-15028.00",
              priceAvailable: true,
              totalReturnPct: 2.42,
            },
            {
              ticker: "PAMP",
              name: "Pampa Holding S.A.",
              quantity: "40",
              marketValue: "37034.00",
              priceAvailable: true,
              totalReturnPct: -0.45,
            },
            {
              ticker: "METR",
              name: "MetroGAS S.A.",
              quantity: "500",
              marketValue: "114750.00",
              priceAvailable: true,
              totalReturnPct: -8.2,
            },
          ],
        },
      },
      errorBody(
        400,
        "VALIDATION_ERROR",
        "`userId` no es entero > 0.",
        "Parámetros inválidos: userId: Too small: expected number to be >0",
      ),
      errorBody(
        404,
        "USER_NOT_FOUND",
        "El usuario no existe.",
        "No existe el usuario 999.",
      ),
    ],
    errorCodes: ["VALIDATION_ERROR", "USER_NOT_FOUND"],
  },
  {
    expressPath: "/instruments",
    method: "get",
    summary: "Buscar instrumentos",
    description:
      "Sin `query` (ausente, vacía o sólo espacios) devuelve el listado inicial; con texto " +
      "(se recorta) es match parcial case-insensitive sobre `ticker` y/o `name`. `MONEDA` nunca " +
      "aparece. `limit` es entero 1..100 con default 10; fuera de rango, `query` repetida o " +
      "no-string, o parámetro desconocido es 400 (la `query` ausente/vacía NUNCA es inválida). " +
      "Respuesta: array plano ordenado por ticker. `price` es el último precio de sesión " +
      "disponible (Yahoo) y `previousClose` el cierre " +
      "de la sesión anterior, ambos string monetario de 2 decimales; `dailyVariationPct` es number " +
      "redondeado a 2 decimales. Campos no-nullable: el instrumento sin cotización computable se " +
      "OMITE y el cupo se completa con los siguientes candidatos hasta agotar el catálogo. " +
      "Proveedor indisponible (timeout / rate-limit) ⇒ 503: sin listado parcial como éxito y sin " +
      "precios del seed.",
    query: InstrumentSearchQuerySchema,
    responses: [
      {
        // Sin ejemplo 200: los precios ya no salen del seed (UC-2 Rev. 2, los
        // precios SON la respuesta y vienen de Yahoo en vivo). La captura real
        // queda para la verificación HTTP en vivo (A5); inventar una cotización
        // acá haría el ejemplo irreproducible contra el servidor.
        status: 200,
        description:
          "Coincidencias ordenadas por ticker, con el último precio de sesión disponible "
          + "(sin ejemplo 200: " +
          "la captura real queda para la verificación en vivo del despliegue local).",
        schema: InstrumentSearchResponseSchema,
      },
      errorBody(
        400,
        "VALIDATION_ERROR",
        "`limit` fuera de 1..100, `query` repetida o de formato no-string, o parámetro "
        + "desconocido (`query` ausente/vacía es válida: listado inicial).",
        "Query inválida: limit: Too big: expected number to be <=100",
      ),
      errorBody(
        503,
        "MARKET_DATA_SERVICE_UNAVAILABLE",
        "El proveedor de cotizaciones no responde (timeout o rate-limit): no hay 200 parcial ni precios de seed.",
        "El servicio de cotizaciones (Yahoo Finance) no está disponible. Intentá nuevamente más tarde.",
      ),
    ],
    errorCodes: ["VALIDATION_ERROR", "MARKET_DATA_SERVICE_UNAVAILABLE"],
  },
  {
    expressPath: "/users/:userId/orders",
    method: "post",
    summary: "Enviar una orden",
    description:
      "Persiste SIEMPRE que el input sea válido: 201 también para resultados `REJECTED` o " +
      "`CANCELLED` (el negocio rechazó la orden, no el endpoint). `size` es entero 1..2147483647. " +
      "`MARKET` se llena al precio de referencia y acepta `price` omitido o `null` (un número es " +
      "400); `LIMIT` exige `price` > 0. `LIMIT GTC` queda `NEW` y reserva; `IOC/FOK` se evalúan " +
      "una vez. Con `Idempotency-Key`: misma key + mismo payload devuelve la orden original; " +
      "payload distinto → 409; `reason` es `null` en el replay.",
    params: CreateOrderParamsSchema,
    idempotencyHeader: true,
    body: CreateOrderBodySchema,
    responses: [
      {
        status: 201,
        description: "Orden creada (FILLED, NEW, REJECTED o CANCELLED).",
        schema: OrderResponseSchema,
        example: {
          id: 14,
          instrumentId: 45,
          side: "BUY",
          type: "LIMIT",
          timeInForce: "GTC",
          status: "REJECTED",
          size: 1000000,
          price: "100.00",
          filledPrice: null,
          filledAt: null,
          datetime: "2026-11-04T10:27:18",
          reason: "INSUFFICIENT_FUNDS",
        },
      },
      errorBody(
        400,
        "VALIDATION_ERROR",
        "Body inválido (XOR, LIMIT sin price, MARKET con price) o header inválido.",
        "Body inválido: price: LIMIT requiere price > 0.",
      ),
      errorBody(
        400,
        "INSTRUMENT_NOT_OPERABLE",
        "El instrumento es `MONEDA`: no operable.",
        "ARS es MONEDA: no operable (DECISIONS.md).",
      ),
      errorBody(
        404,
        "USER_NOT_FOUND",
        "El usuario no existe.",
        "No existe el usuario 999.",
      ),
      errorBody(
        404,
        "INSTRUMENT_NOT_FOUND",
        "El instrumento no existe.",
        "No existe el instrumento (instrumentId 999999).",
      ),
      errorBody(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Misma `Idempotency-Key` con otro payload.",
        "Idempotency-Key ya usada con otro payload (orden existente 15).",
      ),
    ],
    errorCodes: [
      "VALIDATION_ERROR",
      "INSTRUMENT_NOT_OPERABLE",
      "USER_NOT_FOUND",
      "INSTRUMENT_NOT_FOUND",
      "IDEMPOTENCY_CONFLICT",
    ],
  },
  {
    expressPath: "/orders/:orderId",
    method: "delete",
    summary: "Cancelar una orden",
    description:
      "Sólo órdenes `NEW`. La transición es atómica (`UPDATE … WHERE status='NEW'`), así que un " +
      "doble DELETE concurrente devuelve una 200 y una 422. Cancelar libera la reserva.",
    params: CancelOrderParamsSchema,
    responses: [
      {
        status: 200,
        description: "La orden quedó `CANCELLED` (200: el 201 está reservado para creación).",
        schema: OrderResponseSchema,
        example: {
          id: 12,
          instrumentId: 45,
          side: "BUY",
          type: "LIMIT",
          timeInForce: "GTC",
          status: "CANCELLED",
          size: 1,
          price: "100.00",
          filledPrice: null,
          filledAt: null,
          datetime: "2026-11-04T10:27:08",
          reason: null,
        },
      },
      errorBody(
        400,
        "VALIDATION_ERROR",
        "`orderId` no es entero > 0.",
        "Parámetros inválidos: orderId: Too small: expected number to be >0",
      ),
      errorBody(
        404,
        "ORDER_NOT_FOUND",
        "La orden no existe.",
        "No existe la orden 999999.",
      ),
      errorBody(
        422,
        "ORDER_NOT_CANCELLABLE",
        "La orden no está `NEW` (ya llena, cancelada o rechazada).",
        "La orden 1 no está NEW (status 'FILLED'): sólo se cancelan órdenes NEW.",
      ),
    ],
    errorCodes: ["VALIDATION_ERROR", "ORDER_NOT_FOUND", "ORDER_NOT_CANCELLABLE"],
  },
  {
    expressPath: "/users/:userId/transfers",
    method: "post",
    summary: "Transferir cash",
    description:
      "Transferencia = orden del instrumento `ARS` (`price` 1.00, `size` = pesos). `CASH_IN` → " +
      "`FILLED` inmediata; `CASH_OUT` valida contra el disponible (`settled − reservas`) y si no " +
      "alcanza persiste `REJECTED INSUFFICIENT_FUNDS` con 201. Cambio incompatible (D3/D4): el monto " +
      "se mueve EXACTO con centavos (sin floor: 123.45 acredita 123.45); `amountArs` de entrada es " +
      "string decimal canónico (los números JSON se rechazan) y `size` de la respuesta es el monto " +
      "como string de 2 decimales (\"123.00\" para un cash histórico de 123).",
    params: CreateTransferParamsSchema,
    idempotencyHeader: true,
    body: CreateTransferBodySchema,
    responses: [
      {
        status: 201,
        description: "Transferencia creada (FILLED o REJECTED persistida).",
        schema: OrderResponseSchema,
        example: {
          id: 13,
          instrumentId: 66,
          side: "CASH_IN",
          type: "MARKET",
          timeInForce: "GTC",
          status: "FILLED",
          size: "123.00",
          price: "1.00",
          filledPrice: "1.00",
          filledAt: "2026-11-04T10:27:08",
          datetime: "2026-11-04T10:27:08",
          reason: null,
        },
      },
      errorBody(
        400,
        "VALIDATION_ERROR",
        "Monto ≤ 0, no numérico, o `side` inválido.",
        "Body inválido: amountArs: El monto debe ser mayor que 0.",
      ),
      errorBody(
        404,
        "USER_NOT_FOUND",
        "El usuario no existe.",
        "No existe el usuario 999.",
      ),
      errorBody(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Misma `Idempotency-Key` con otro payload.",
        "Idempotency-Key ya usada con otro payload (orden existente 17).",
      ),
    ],
    errorCodes: ["VALIDATION_ERROR", "USER_NOT_FOUND", "IDEMPOTENCY_CONFLICT"],
  },
];

export const OPERATIONS: readonly OperationDoc[] =
  OPERATION_DEFINITIONS.map(withTransversalErrors);

/** Header de idempotencia (opcional en POST /orders y POST /transfers). */
export const IDEMPOTENCY_HEADER_SCHEMA = IdempotencyKeySchema;
