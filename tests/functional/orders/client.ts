// Célula D — cliente HTTP de los tests funcionales de UC-3.
//
// supertest contra `serverApp` (src/http/server.ts): la composición DI del
// orquestador. En FASE 2 es un STUB (buildApp([]) — sin routers montados),
// así que todo responde 404: es el rojo esperado de esta suite, que pasará
// a verde cuando la FASE 3 monte el router de orders.
//
// Dinero (AGENTS.md): los esperados se computan con Decimal construido
// desde strings y se comparan como Decimal — nunca float.

import { Decimal } from "decimal.js";
import express from "express";
import type { Express } from "express";
import request, { type Response } from "supertest";
import {
  IDEMPOTENCY_KEY_HEADER,
  type ApiErrorBody,
  type OrderResponse,
  type OrderType,
  type PortfolioResponse,
  type TimeInForce,
  type TradingSide,
} from "../../../src/contracts/index.js";

/**
 * App bajo test: `serverApp` (src/http/server.ts), la composición DI del
 * orquestador.
 *
 * FASE 2: serverApp es un STUB. OJO: con cero routers `app.use("/api",
 * ...routers)` lanza `TypeError: app.use() requires a middleware function`
 * ANTES de atender ningún request (bug del stub: spread vacío ⇒ app.use
 * sin middleware). Como esta célula no puede tocar src/**, serverApp se
 * carga LAZY: si su construcción lanza (hoy), los tests corren contra un
 * fallback LOCAL que responde 404 a todo — exactamente el comportamiento
 * que el stub debe tener ("sin routers ⇒ 404"), para que el rojo sea por
 * los 404/asserts de cada test y no por un TypeError de suite. En cuanto la
 * FASE 3 monte routers, serverApp construye y el fallback queda sin uso
 * (se advierte una sola vez por corrida si entra el fallback).
 */
type ServerModule = { readonly serverApp: Express };

let cachedServerApp: Express | undefined;
let announcedFallback = false;

const buildFallbackApp = (): Express => {
  const app = express();
  app.use(express.json()); // mismo middleware que buildApp — sin routers ⇒ 404
  return app;
};

const loadServerApp = (): Express => {
  if (cachedServerApp !== undefined) {
    return cachedServerApp;
  }
  try {
    const serverModule = jest.requireActual<ServerModule>(
      "../../../src/http/server.js",
    );
    cachedServerApp = serverModule.serverApp;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!announcedFallback) {
      announcedFallback = true;
      console.warn(
        `[Célula D] serverApp no se pudo construir (${reason}). ` +
          "Corriendo contra el fallback local que responde 404 a todo (el " +
          "comportamiento esperado del stub) — ver OPEN del reporte de la célula.",
      );
    }
    cachedServerApp = buildFallbackApp();
  }
  return cachedServerApp;
};

/** Body de envío de orden — shape en el wire de CreateOrderRequestSchema. */
export interface OrderPayload {
  readonly instrumentId?: number;
  readonly ticker?: string;
  readonly side: TradingSide;
  readonly type: OrderType;
  readonly timeInForce?: TimeInForce;
  readonly size?: number;
  /** Dinero: número o string en el wire (PositiveArsInputSchema). */
  readonly amountArs?: number | string;
  readonly price?: number | string;
}

/** POST /api/users/:userId/orders (UC-3), con Idempotency-Key opcional. */
export const postOrder = async (
  userId: number,
  payload: OrderPayload,
  idempotencyKey?: string,
): Promise<Response> => {
  const req = request(loadServerApp())
    .post(`/api/users/${String(userId)}/orders`)
    .send(payload);
  if (idempotencyKey !== undefined) {
    req.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  }
  return req;
};

/**
 * GET /api/users/:userId/portfolio (UC-1) — sólo lectura, para los deltas
 * de cash de UC-3. Sin asserts propios: en esta suite el fallo debe venir
 * del POST que se está testeando, no del helper.
 */
export const getPortfolio = async (
  userId: number,
): Promise<PortfolioResponse> =>
  (
    await request(loadServerApp()).get(
      `/api/users/${String(userId)}/portfolio`,
    )
  ).body as PortfolioResponse;

/** Body de orden de una respuesta de POST /orders (OrderResponse del contrato). */
export const asOrderBody = (res: Response): OrderResponse =>
  res.body as OrderResponse;

/** Body de error del contrato ({ error: { code, message } }). */
export const asErrorBody = (res: Response): ApiErrorBody =>
  res.body as ApiErrorBody;

/** size (acciones) × precio (string ARS) → string ARS exacto con 2 decimales. */
export const costArs = (size: number, priceArs: string): string =>
  new Decimal(String(size)).mul(new Decimal(priceArs)).toDecimalPlaces(2).toFixed(2);

/**
 * Cash disponible esperado después de un delta: before ± delta (Decimal
 * desde strings, nunca float). Es un string ARS con 2 decimales para
 * comparar contra el portfolio serializado.
 */
export const expectedCashAfter = (
  cashBefore: unknown,
  deltaArs: string,
): string => {
  if (typeof cashBefore !== "number") {
    throw new Error(
      `GET /portfolio no devolvió cash numérico (llegó ${String(cashBefore)}) — ¿endpoint de portfolio no montado?`,
    );
  }
  return new Decimal(String(cashBefore))
    .plus(new Decimal(deltaArs))
    .toFixed(2);
};

/**
 * Assert de dinero serializado: el número JSON del contrato (MoneyArs,
 * ≤2 decimales) debe representar EXACTAMENTE el monto esperado. La
 * comparación es Decimal(String(actual)) vs Decimal(expected), nunca float.
 */
export const expectMoneyArs = (actual: unknown, expectedArs: string): void => {
  if (typeof actual !== "number") {
    throw new Error(
      `Se esperaba money serializado (number) igual a ${expectedArs}; llegó: ${String(actual)}`,
    );
  }
  expect(new Decimal(String(actual)).toFixed(2)).toBe(expectedArs);
};