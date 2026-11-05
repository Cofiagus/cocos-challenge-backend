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
}

export interface OperationDoc {
  /** Path tal como lo declara Express (con `:param`). */
  readonly expressPath: string;
  readonly method: "get" | "post" | "delete";
  readonly summary: string;
  readonly description: string;
  readonly params?: z.ZodTypeAny;
  readonly query?: z.ZodTypeAny;
  /** `Idempotency-Key` opcional. */
  readonly idempotencyHeader?: boolean;
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
): ResponseDoc => ({
  status,
  description: `${description} Código: \`${code}\`.`,
  schema: ApiErrorBodySchema,
  example: { error: { code, message } },
});

interface TransversalError {
  readonly code: KnownErrorCode;
  readonly response: ResponseDoc;
}

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
  const transversal =
    operation.body === undefined
      ? TRANSVERSAL_ERRORS
      : [...TRANSVERSAL_ERRORS, ...BODY_TRANSVERSAL_ERRORS];
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

const OPERATION_DEFINITIONS: readonly OperationDoc[] = [
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
              totalReturnPct: -2.42,
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
      "Match parcial case-insensitive sobre `ticker` y/o `name`. `MONEDA` nunca aparece. " +
      "La respuesta es un array plano (sin wrapper). Sin marketdata, `price`, `previousClose` y " +
      "`dailyVariationPct` vienen en `null`.",
    query: InstrumentSearchQuerySchema,
    responses: [
      {
        status: 200,
        description: "Coincidencias ordenadas por ticker.",
        schema: InstrumentSearchResponseSchema,
        example: [
          {
            ticker: "METR",
            name: "MetroGAS S.A.",
            type: "ACCIONES",
            price: "229.50",
            previousClose: "232.00",
            dailyVariationPct: -1.08,
          },
        ],
      },
      errorBody(
        400,
        "VALIDATION_ERROR",
        "`query` vacía o ausente; `limit` fuera de 1..100.",
        "Query inválida: query: Invalid input: expected string, received undefined",
      ),
    ],
    errorCodes: ["VALIDATION_ERROR"],
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
