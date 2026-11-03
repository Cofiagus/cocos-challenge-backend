// Célula F — tests funcionales UC-4 (DELETE /api/orders/:orderId).
//
// Corren contra la app LOCAL (buildCancelTestApp: router de cancelación +
// router de orders para crear las órdenes + router de portfolio para ver la
// reserva) con los repos Prisma REALES sobre la DB AISLADA
// cocos_challenge_cancel (self-reset en beforeAll — ver ./support.ts).
//
// Dinero (AGENTS.md): esperados con Decimal desde strings, nunca float.
// Cobertura: la transición NEW→CANCELLED con su liberación de reserva, el
// 422 SIN mutar (segunda / FILLED / CANCELLED), el 404/400 del borde, el
// doble DELETE concurrente (el guard WHERE status='NEW' lo resuelve) y el
// golden del seed (user 1).

import request from "supertest";
import type { Response } from "supertest";
import type { PortfolioResponse } from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
  SEED_USER_1_PORTFOLIO,
  SEED_USER_EMILIANO_ID,
} from "../../helpers/fixtures.js";
import {
  buildCancelTestApp,
  closeCancelDbPool,
  costArs,
  expectedCashAfter,
  expectMoneyArs,
  fetchCancelOrderEvents,
  fetchCancelOrderRow,
  type CancelOrderEventRow,
  type CancelOrderRow,
  insertTestCashIn,
  insertTestUser,
  resetCancelDatabase,
} from "./support.js";

// El reset (drop/create + migrate deploy + seed) es lento; los tests no.
jest.setTimeout(30_000);

const app = buildCancelTestApp();

/** Seed (db/seed.sql): orden 5 = LOMA(45) user 1 LIMIT BUY 50 @ 710.00 NEW. */
const SEED_ORDER_LOMA_NEW_ID = 5;
/** Seed: orden 3 = PAMP(47) user 1 LIMIT BUY 50 @ 920.00 CANCELLED. */
const SEED_ORDER_PAMP_CANCELLED_ID = 3;

/** Secuencia para emails únicos (fixture de usuario fresco). */
let userSeq = 0;

/** Usuario fresco con cash liquidado (CASH_IN de fixture) — aislamiento por test. */
const freshUserWithCash = async (cashArs: string): Promise<number> => {
  userSeq += 1;
  const userId = await insertTestUser(
    `cellf-${Date.now()}-${String(userSeq)}@test.local`,
  );
  await insertTestCashIn(userId, cashArs);
  return userId;
};

const postOrder = async (
  userId: number,
  payload: Record<string, unknown>,
): Promise<Response> =>
  request(app).post(`/api/users/${String(userId)}/orders`).send(payload);

const deleteOrder = async (orderId: number | string): Promise<Response> =>
  request(app).delete(`/api/orders/${String(orderId)}`);

const getPortfolio = async (userId: number): Promise<PortfolioResponse> => {
  const res = await request(app).get(
    `/api/users/${String(userId)}/portfolio`,
  );
  return res.body as PortfolioResponse;
};

/** code del body de error (`{ error: { code, message } }`). */
const errorCode = (res: Response): unknown =>
  (res.body as { error?: { code?: unknown } }).error?.code;

/** metadata jsonb → su campo origin (USER en los eventos de cancelación). */
const metadataOrigin = (metadata: unknown): unknown => {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }
  return (metadata as Record<string, unknown>)["origin"];
};

/** Id de la orden creada por un POST (201 con body.id). */
const createdOrderId = (res: Response): number => {
  const id = (res.body as Record<string, unknown>)["id"];
  if (typeof id !== "number") {
    throw new Error(`POST /orders no devolvió id numérico (llegó ${String(id)}).`);
  }
  return id;
};

/** Eventos CANCELLED de una orden (los de auditoría de UC-4). */
const cancelledEvents = (
  events: readonly CancelOrderEventRow[],
): readonly CancelOrderEventRow[] =>
  events.filter((event) => event.eventType === "CANCELLED");

beforeAll(async () => {
  // DB de esta célula al estado del seed: suite autocontenida.
  await resetCancelDatabase();
}, 240_000);

afterAll(async () => {
  await closeCancelDbPool();
});

// ---------------------------------------------------------------------------
// Happy path: NEW → CANCELLED libera la reserva
// ---------------------------------------------------------------------------

describe("UC-4 cancel · NEW", () => {
  it("⇒ 200 CANCELLED (reason null) y LIBERA la reserva: reservedCash ↓ limit×size, cash disponible ↑ lo mismo", async () => {
    const userId = await freshUserWithCash("100000.00");
    // Baseline ANTES de crear la orden: cash 100000, sin reservas.
    const baseline = await getPortfolio(userId);
    expectMoneyArs(baseline.reservedCash, "0.00");

    // NEW vía POST LIMIT GTC (la reserva implícita es size × límite).
    const created = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 2,
      price: 250, // sin timeInForce ⇒ default GTC ⇒ NEW
    });
    expect(created.status).toBe(201);
    expect((created.body as Record<string, unknown>)["status"]).toBe("NEW");
    const orderId = createdOrderId(created);

    // Antes de cancelar: la reserva está visible en el portfolio.
    const before = await getPortfolio(userId);
    expectMoneyArs(before.reservedCash, costArs(2, "250.00")); // 500 reservados
    expectMoneyArs(
      before.cash,
      expectedCashAfter(baseline.cash, `-${costArs(2, "250.00")}`), // 99500
    );

    const res = await deleteOrder(orderId);
    expect(res.status).toBe(200); // decisión firmada: 200 (201 es para creación)
    const body = res.body as Record<string, unknown>;
    expect(body["id"]).toBe(orderId);
    expect(body["status"]).toBe("CANCELLED");
    expect(body["reason"]).toBeNull(); // cancelación por usuario: sin razón
    expect(body["side"]).toBe("BUY");
    expect(body["size"]).toBe(2);
    expectMoneyArs(body["price"], "250.00");
    expect(body["filledPrice"]).toBeNull();
    expect(body["filledAt"]).toBeNull();

    // Persistida: la fila quedó CANCELLED.
    const row = await fetchCancelOrderRow(orderId);
    expect(row?.status).toBe("CANCELLED");
    expect(row?.size).toBe(2);

    // La reserva se libera: reservedCash baja 2 × 250 y el disponible sube lo mismo.
    const after = await getPortfolio(userId);
    expectMoneyArs(
      after.reservedCash,
      expectedCashAfter(before.reservedCash, `-${costArs(2, "250.00")}`), // 500 → 0
    );
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, costArs(2, "250.00")), // 99500 → 100000
    );
  });
});

// ---------------------------------------------------------------------------
// Evento de auditoría (misma tx que la mutación)
// ---------------------------------------------------------------------------

describe("UC-4 cancel · evento", () => {
  it("order_events tiene la fila CANCELLED (reason null, metadata origin USER), en la misma tx", async () => {
    const userId = await freshUserWithCash("10000.00");
    const created = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 1,
      price: 210,
    });
    const orderId = createdOrderId(created);

    // El submit dejó su ACCEPTED; la cancelación agrega EXACTAMENTE un
    // CANCELLED después (append en la MISMA tx que el UPDATE guard).
    const before = await fetchCancelOrderEvents(orderId);
    expect(before.map((event) => event.eventType)).toEqual(["ACCEPTED"]);

    const res = await deleteOrder(orderId);
    expect(res.status).toBe(200);

    const events = await fetchCancelOrderEvents(orderId);
    expect(events).toHaveLength(2);
    const cancelled = events[1];
    expect(cancelled?.eventType).toBe("CANCELLED");
    expect(cancelled?.reason).toBeNull(); // las razones del contrato son de rechazo/IOC-FOK
    expect(metadataOrigin(cancelled?.metadata)).toBe("USER");
  });
});

// ---------------------------------------------------------------------------
// 422 SIN mutar: no-NEW no se cancela
// ---------------------------------------------------------------------------

describe("UC-4 cancel · 422 ORDER_NOT_CANCELLABLE sin mutar", () => {
  it("segunda cancelación sobre la misma orden ⇒ 422, fila igual, sin segundo evento", async () => {
    const userId = await freshUserWithCash("10000.00");
    const created = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 1,
      price: 210,
    });
    const orderId = createdOrderId(created);

    const first = await deleteOrder(orderId);
    expect(first.status).toBe(200);

    const rowBefore: CancelOrderRow | undefined =
      await fetchCancelOrderRow(orderId);
    const eventsBefore = await fetchCancelOrderEvents(orderId);
    expect(cancelledEvents(eventsBefore)).toHaveLength(1);

    const second = await deleteOrder(orderId);
    expect(second.status).toBe(422);
    expect(errorCode(second)).toBe("ORDER_NOT_CANCELLABLE");

    // SIN mutar: la fila quedó exactamente igual y no hay segundo evento.
    const rowAfter = await fetchCancelOrderRow(orderId);
    expect(rowAfter).toEqual(rowBefore);
    const eventsAfter = await fetchCancelOrderEvents(orderId);
    expect(eventsAfter).toEqual(eventsBefore);
  });

  it("orden FILLED (creada vía POST MARKET) ⇒ 422, fila igual, sin evento CANCELLED", async () => {
    const userId = await freshUserWithCash("100000.00");
    const created = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 3, // ref PAMP 925.85 ⇒ FILLED al enviar
    });
    expect((created.body as Record<string, unknown>)["status"]).toBe("FILLED");
    const orderId = createdOrderId(created);

    const rowBefore = await fetchCancelOrderRow(orderId);
    const eventsBefore = await fetchCancelOrderEvents(orderId);
    expect(cancelledEvents(eventsBefore)).toHaveLength(0);

    const res = await deleteOrder(orderId);
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe("ORDER_NOT_CANCELLABLE");

    const rowAfter = await fetchCancelOrderRow(orderId);
    expect(rowAfter).toEqual(rowBefore); // FILLED intacta
    const eventsAfter = await fetchCancelOrderEvents(orderId);
    expect(cancelledEvents(eventsAfter)).toHaveLength(0);
  });

  it("orden CANCELLED (seed: PAMP del user 1) ⇒ 422 ídem, sin evento", async () => {
    const rowBefore = await fetchCancelOrderRow(SEED_ORDER_PAMP_CANCELLED_ID);
    expect(rowBefore?.status).toBe("CANCELLED");

    const res = await deleteOrder(SEED_ORDER_PAMP_CANCELLED_ID);
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe("ORDER_NOT_CANCELLABLE");

    const rowAfter = await fetchCancelOrderRow(SEED_ORDER_PAMP_CANCELLED_ID);
    expect(rowAfter).toEqual(rowBefore);
    const events = await fetchCancelOrderEvents(SEED_ORDER_PAMP_CANCELLED_ID);
    expect(cancelledEvents(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Errores del borde: 404 / 400
// ---------------------------------------------------------------------------

describe("UC-4 cancel · errores del borde", () => {
  it("orderId inexistente ⇒ 404 ORDER_NOT_FOUND con body de error", async () => {
    const res = await deleteOrder(999999);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("ORDER_NOT_FOUND");
    const error = (res.body as { error?: { message?: unknown } }).error;
    expect(typeof error?.message).toBe("string");
  });

  it.each(["abc", 0, -1])("orderId %s ⇒ 400 VALIDATION_ERROR", async (orderId) => {
    const res = await deleteOrder(orderId);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Concurrencia: el guard WHERE status='NEW' decide
// ---------------------------------------------------------------------------

describe("UC-4 cancel · doble DELETE concurrente sobre la misma NEW", () => {
  it("⇒ EXACTAMENTE una 200 y una 422 (una sola transición, un solo evento, una sola liberación)", async () => {
    const userId = await freshUserWithCash("10000.00");
    const created = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 2,
      price: 250,
    });
    const orderId = createdOrderId(created);
    const before = await getPortfolio(userId); // reservado: 2 × 250

    const settled = await Promise.allSettled([
      deleteOrder(orderId),
      deleteOrder(orderId),
    ]);
    const responses = settled.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("DELETE inyectó rechazo (no esperado en esta suite).");
      }
      return result.value;
    });
    expect(responses).toHaveLength(2);

    // El guard WHERE status='NEW' (markCancelled, B) garantiza que UNA sola
    // transición gane: una 200, una 422 — sin importar el orden de llegada.
    const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 422]);
    const ok = responses.find((res) => res.status === 200);
    const rejected = responses.find((res) => res.status === 422);
    expect((ok?.body as Record<string, unknown>)["status"]).toBe("CANCELLED");
    expect(errorCode(rejected ?? ({} as Response))).toBe("ORDER_NOT_CANCELLABLE");

    // Una sola transición persistida, un solo evento CANCELLED.
    const row = await fetchCancelOrderRow(orderId);
    expect(row?.status).toBe("CANCELLED");
    const events = await fetchCancelOrderEvents(orderId);
    expect(cancelledEvents(events)).toHaveLength(1);

    // Una sola liberación de la reserva (no dos).
    const after = await getPortfolio(userId);
    expectMoneyArs(
      after.reservedCash,
      expectedCashAfter(before.reservedCash, `-${costArs(2, "250.00")}`), // 500 → 0
    );
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, costArs(2, "250.00")), // vuelve al disponible pleno
    );
  });
});

// ---------------------------------------------------------------------------
// Golden del seed: cancelar una NEW del user 1 baja SUS reservas
// ---------------------------------------------------------------------------

describe("UC-4 cancel · seed (user 1)", () => {
  it("cancelar la NEW 5 (LOMA 50 @ 710) ⇒ reservedCash 125500 → 90000, disponible 627500 → 663000", async () => {
    const before = await getPortfolio(SEED_USER_EMILIANO_ID);
    // Golden del seed: 2 NEW BUY (LOMA 5 + BMA 7) reservan 125500; disponible 627500.
    expectMoneyArs(before.reservedCash, SEED_USER_1_PORTFOLIO.cashReservedArs);
    expectMoneyArs(before.cash, SEED_USER_1_PORTFOLIO.cashAvailableArs);

    const res = await deleteOrder(SEED_ORDER_LOMA_NEW_ID);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)["status"]).toBe("CANCELLED");

    // La reserva de la LOMA (50 × 710 = 35500) se libera del user 1.
    const after = await getPortfolio(SEED_USER_EMILIANO_ID);
    expectMoneyArs(
      after.reservedCash,
      expectedCashAfter(
        before.reservedCash,
        `-${costArs(50, "710.00")}`, // 125500 − 35500 = 90000
      ),
    );
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, costArs(50, "710.00")), // 627500 + 35500 = 663000
    );
  });
});
