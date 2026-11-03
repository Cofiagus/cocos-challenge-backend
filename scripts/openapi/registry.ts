// Registro declarativo de las 5 operaciones de la API — la entrada del generador de OpenAPI.
//
// Una operación = método + ruta de Express + schemas Zod (params/query/header/body/respuestas) +
// códigos de error + ejemplo real. Es la ÚNICA lista de rutas de la documentación: el test
// `tests/docs/openapi.test.ts` compara este registro contra los `router.<verbo>("...")` de
// `src/http/**`, y falla si divergen.

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

/** Códigos de error que la API puede devolver (los de `API_ERROR_CODES` + INSTRUMENT_NOT_FOUND). */
export const KNOWN_ERROR_CODES = [
  "VALIDATION_ERROR",
  "INSTRUMENT_NOT_OPERABLE",
  "USER_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "INSTRUMENT_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "ORDER_NOT_CANCELLABLE",
] as const;

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
  readonly errorCodes: readonly (typeof KNOWN_ERROR_CODES)[number][];
}

/** Respuesta de error: el schema es el del contrato y el ejemplo fija el `code` estable. */
const errorBody: (
  status: number,
  code: (typeof KNOWN_ERROR_CODES)[number],
  description: string,
) => ResponseDoc = (status, code, description) => ({
  status,
  description: `${description} Código: \`${code}\`.`,
  schema: ApiErrorBodySchema,
  example: { error: { code, message: description } },
});

export const OPERATIONS: readonly OperationDoc[] = [
  {
    expressPath: "/users/:userId/portfolio",
    method: "get",
    summary: "Portfolio de un usuario",
    description:
      "Proyección de `orders`: `cash` = settled − reservado por órdenes `NEW` de compra. " +
      "Posiciones con cantidad 0 no se listan; sin precio de referencia `marketValue` es `null` " +
      "y la posición no suma a `totalAccountValue`. `MONEDA` nunca aparece.",
    params: PortfolioParamsSchema,
    responses: [
      {
        status: 200,
        description: "Portfolio derivado (usuario 1 del seed).",
        schema: PortfolioResponseSchema,
        example: {
          cash: 627500,
          reservedCash: 125500,
          totalAccountValue: 764256,
          positions: [
            {
              ticker: "PAMP",
              name: "Pampa Energía S.A.",
              quantity: 40,
              marketValue: 37034,
              priceAvailable: true,
              totalReturnPct: -0.45,
            },
            {
              ticker: "BMA",
              name: "Banco Macro S.A.",
              quantity: -10,
              marketValue: -15028,
              priceAvailable: true,
              totalReturnPct: null,
            },
          ],
        },
      },
      errorBody(400, "VALIDATION_ERROR", "`userId` no es entero > 0."),
      errorBody(404, "USER_NOT_FOUND", "El usuario no existe."),
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
            price: 229.5,
            previousClose: 232,
            dailyVariationPct: -1.08,
          },
        ],
      },
      errorBody(400, "VALIDATION_ERROR", "`query` vacía o ausente; `limit` fuera de 1..100."),
    ],
    errorCodes: ["VALIDATION_ERROR"],
  },
  {
    expressPath: "/users/:userId/orders",
    method: "post",
    summary: "Enviar una orden",
    description:
      "Persiste SIEMPRE que el input sea válido: 201 también para resultados `REJECTED` o " +
      "`CANCELLED` (el negocio rechazó la orden, no el endpoint). `MARKET` se llena al precio de " +
      "referencia; `LIMIT GTC` queda `NEW` y reserva; `IOC/FOK` se evalúan una vez. " +
      "Con `Idempotency-Key`: misma key + mismo payload devuelve la orden original; payload " +
      "distinto → 409; `reason` es `null` en el replay.",
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
          size: 1,
          price: 100,
          filledPrice: null,
          filledAt: null,
          datetime: "2026-11-03T12:00:00",
          reason: "INSUFFICIENT_FUNDS",
        },
      },
      errorBody(400, "VALIDATION_ERROR", "Body inválido (XOR, LIMIT sin price, MARKET con price) o header inválido."),
      errorBody(400, "INSTRUMENT_NOT_OPERABLE", "El instrumento es `MONEDA`: no operable."),
      errorBody(404, "USER_NOT_FOUND", "El usuario no existe."),
      errorBody(404, "INSTRUMENT_NOT_FOUND", "El instrumento no existe."),
      errorBody(409, "IDEMPOTENCY_CONFLICT", "Misma `Idempotency-Key` con otro payload."),
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
          id: 5,
          instrumentId: 45,
          side: "BUY",
          type: "LIMIT",
          timeInForce: "GTC",
          status: "CANCELLED",
          size: 50,
          price: 710,
          filledPrice: null,
          filledAt: null,
          datetime: "2026-07-12T10:00:00",
          reason: null,
        },
      },
      errorBody(400, "VALIDATION_ERROR", "`orderId` no es entero > 0."),
      errorBody(404, "ORDER_NOT_FOUND", "La orden no existe."),
      errorBody(422, "ORDER_NOT_CANCELLABLE", "La orden no está `NEW` (ya llena, cancelada o rechazada)."),
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
      "alcanza persiste `REJECTED INSUFFICIENT_FUNDS` con 201. `size` es entero: 123.45 acredita 123.",
    params: CreateTransferParamsSchema,
    idempotencyHeader: true,
    body: CreateTransferBodySchema,
    responses: [
      {
        status: 201,
        description: "Transferencia creada (FILLED o REJECTED persistida).",
        schema: OrderResponseSchema,
        example: {
          id: 20,
          instrumentId: 66,
          side: "CASH_IN",
          type: "MARKET",
          timeInForce: "GTC",
          status: "FILLED",
          size: 123,
          price: 1,
          filledPrice: 1,
          filledAt: "2026-11-03T12:00:00",
          datetime: "2026-11-03T12:00:00",
          reason: null,
        },
      },
      errorBody(400, "VALIDATION_ERROR", "Monto ≤ 0, no numérico, o `side` inválido."),
      errorBody(404, "USER_NOT_FOUND", "El usuario no existe."),
      errorBody(409, "IDEMPOTENCY_CONFLICT", "Misma `Idempotency-Key` con otro payload."),
    ],
    errorCodes: ["VALIDATION_ERROR", "USER_NOT_FOUND", "IDEMPOTENCY_CONFLICT"],
  },
];

/** Header de idempotencia (opcional en POST /orders y POST /transfers). */
export const IDEMPOTENCY_HEADER_SCHEMA = IdempotencyKeySchema;
