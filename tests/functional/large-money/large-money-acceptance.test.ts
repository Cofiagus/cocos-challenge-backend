// Aceptación E2E de grandes montos (spec `datos-financieros-grandes-montos`,
// D1–D5 firmadas) contra Express + PostgreSQL REALES.
//
// Cada escenario usa un USUARIO FRESCO y fixtures propias: el seed queda
// intacto (sólo se lee el user 1 para la posición heredada). Las requests son
// HTTP reales (supertest) sobre buildApp con los 5 routers y los repos Prisma
// reales; los asserts de filas/eventos van por SQL parametrizado.
//
// Dinero SIEMPRE con `FinancialDecimal` (precisión 64) construido desde
// strings: el `Decimal` global (precisión 20) pierde el centavo en 1e22.

import request from "supertest";
import type { Response } from "supertest";
import {
  IDEMPOTENCY_KEY_HEADER,
  MAX_STORED_ARSS,
  OrderResponseSchema,
  PortfolioResponseSchema,
  type PortfolioResponse,
} from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENT_PAMP_ID,
  SEED_USER_EMILIANO_ID,
} from "../../helpers/fixtures.js";
import {
  FailingAuditOrderRepository,
  buildLargeMoneyTestApp,
  closeLargeMoneyDatabase,
  countAllEvents,
  countAllOrders,
  countEventsForUser,
  countOrdersForUser,
  countOrdersWithIdempotencyKey,
  fetchOrderEvents,
  fetchOrderRow,
  insertHistoricalCash,
  insertTestUser,
  resetLargeMoneyDatabase,
} from "./support.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";

jest.setTimeout(60_000);

/** Máximo por importe/precio almacenado (D1), tomado del contrato. */
const MAX = MAX_STORED_ARSS.toFixed(2);
const MAX_PLUS_CENT = "10000000000000000000000.00";
const MAX_MINUS_CENT = "9999999999999999999999.98";
const TWO_MAX = "19999999999999999999999.98";
const THREE_MAX = "29999999999999999999999.97";
const MAX_AFTER_THREE_CASHES = "10000000000000000000123.45";
const SAFE_INTEGER_CENT_CASE = "90071992547409.93";
const MAX_PLUS_SAFE_INTEGER_CENT = "10000000090071992547409.92";

const app = buildLargeMoneyTestApp();
/** App con el repo de orders envuelto: falla DESPUÉS del evento real. */
const rollbackApp = buildLargeMoneyTestApp(
  new FailingAuditOrderRepository(new PrismaOrderRepository()),
);

let userSeq = 0;

/** Usuario fresco (sin filas) para aislar cada escenario. */
const freshUser = async (): Promise<number> => {
  userSeq += 1;
  return insertTestUser(
    `lm-acceptance-${String(userSeq)}-${String(Date.now())}@test.local`,
  );
};

const postOrder = async (
  userId: number,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> => {
  const req = request(app)
    .post(`/api/users/${String(userId)}/orders`)
    .send(payload);
  if (idempotencyKey !== undefined) {
    req.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  }
  return req;
};

const postTransfer = async (
  userId: number,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> => {
  const req = request(app)
    .post(`/api/users/${String(userId)}/transfers`)
    .send(payload);
  if (idempotencyKey !== undefined) {
    req.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  }
  return req;
};

/** Body de orden validado contra el contrato + forma string del cash. */
const orderBody = (res: Response): Record<string, unknown> => {
  const parsed = OrderResponseSchema.safeParse(res.body);
  if (!parsed.success) {
    throw new Error(
      `OrderResponse fuera del contrato: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return res.body as Record<string, unknown>;
};

const cashAmountOf = (res: Response): string => {
  const body = orderBody(res);
  const size = body["size"];
  if (typeof size !== "string") {
    throw new Error(`size cash debe ser string; llegó ${String(size)}`);
  }
  return size;
};

const getPortfolio = async (userId: number): Promise<PortfolioResponse> => {
  const res = await request(app).get(`/api/users/${String(userId)}/portfolio`);
  expect(res.status).toBe(200);
  const parsed = PortfolioResponseSchema.safeParse(res.body);
  if (!parsed.success) {
    throw new Error(
      `PortfolioResponse fuera del contrato: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
};

const expectErrorCode = (
  res: Response,
  status: number,
  code: string,
): void => {
  expect(res.status).toBe(status);
  expect(
    (res.body as { error?: { code?: unknown } }).error?.code,
  ).toBe(code);
};

const cashIn = async (userId: number, amount: string): Promise<void> => {
  const res = await postTransfer(userId, { amountArs: amount, side: "CASH_IN" });
  expect(res.status).toBe(201);
  expect(orderBody(res)["status"]).toBe("FILLED");
};

beforeAll(async () => {
  await resetLargeMoneyDatabase();
}, 240_000);

afterAll(async () => {
  await closeLargeMoneyDatabase();
});

// ---------------------------------------------------------------------------
// 1 · Cash exacto: centavos, máximo y serialización string de 2 decimales
// ---------------------------------------------------------------------------

describe("1 · cash exacto y serialización", () => {
  it("CASH_IN 0.01 / 123.45 / máximo: response, fila PG, cash y evento exactos", async () => {
    const userId = await freshUser();

    const cents = await postTransfer(userId, {
      amountArs: "0.01",
      side: "CASH_IN",
    });
    expect(cents.status).toBe(201);
    expect(cashAmountOf(cents)).toBe("0.01");
    const centsId = orderBody(cents)["id"];
    expect(typeof centsId).toBe("number");
    expect((await fetchOrderRow(centsId as number))?.size).toBe("0.01");
    expect(
      (await fetchOrderEvents(centsId as number))[0]?.metadata?.["amountArs"],
    ).toBe("0.01");
    expect((await getPortfolio(userId)).cash).toBe("0.01");

    const fractional = await postTransfer(userId, {
      amountArs: "123.45",
      side: "CASH_IN",
    });
    expect(fractional.status).toBe(201);
    expect(cashAmountOf(fractional)).toBe("123.45");
    const fractionalId = orderBody(fractional)["id"];
    expect((await fetchOrderRow(fractionalId as number))?.size).toBe("123.45");
    expect((await getPortfolio(userId)).cash).toBe("123.46");

    const maximum = await postTransfer(userId, {
      amountArs: MAX,
      side: "CASH_IN",
    });
    expect(maximum.status).toBe(201);
    expect(cashAmountOf(maximum)).toBe(MAX);
    const maximumId = orderBody(maximum)["id"];
    const maximumRow = await fetchOrderRow(maximumId as number);
    expect(maximumRow?.size).toBe(MAX);
    expect(maximumRow?.price).toBe("1.00");
    expect(
      (await fetchOrderEvents(maximumId as number))[0]?.metadata?.["amountArs"],
    ).toBe(MAX);

    const portfolio = await getPortfolio(userId);
    expect(portfolio.cash).toBe(MAX_AFTER_THREE_CASHES);
    expect(portfolio.reservedCash).toBe("0.00");
    expect(portfolio.totalAccountValue).toBe(MAX_AFTER_THREE_CASHES);
  });

  it("90071992547409.93 no pierde el centavo y máximo − 0.01 da ...98", async () => {
    const safeUser = await freshUser();
    const safe = await postTransfer(safeUser, {
      amountArs: SAFE_INTEGER_CENT_CASE,
      side: "CASH_IN",
    });
    expect(safe.status).toBe(201);
    expect(cashAmountOf(safe)).toBe(SAFE_INTEGER_CENT_CASE);
    const safeId = orderBody(safe)["id"];
    expect((await fetchOrderRow(safeId as number))?.size).toBe(
      SAFE_INTEGER_CENT_CASE,
    );
    expect((await getPortfolio(safeUser)).cash).toBe(SAFE_INTEGER_CENT_CASE);

    const maxUser = await freshUser();
    await cashIn(maxUser, MAX);
    const drain = await postTransfer(maxUser, {
      amountArs: "0.01",
      side: "CASH_OUT",
    });
    expect(drain.status).toBe(201);
    expect(orderBody(drain)["status"]).toBe("FILLED");
    expect(cashAmountOf(drain)).toBe("0.01");
    const drainId = orderBody(drain)["id"];
    expect((await fetchOrderRow(drainId as number))?.size).toBe("0.01");
    expect((await getPortfolio(maxUser)).cash).toBe(MAX_MINUS_CENT);
  });

  it("cash máximo del seed + otro importe sigue exacto (sin pasar por number)", async () => {
    const userId = await freshUser();
    await cashIn(userId, MAX);
    await cashIn(userId, SAFE_INTEGER_CENT_CASE);
    const portfolio = await getPortfolio(userId);
    expect(portfolio.cash).toBe(MAX_PLUS_SAFE_INTEGER_CENT);
  });
});

// ---------------------------------------------------------------------------
// 2 · 400 del borde sin filas/eventos nuevos
// ---------------------------------------------------------------------------

describe("2 · entradas monetarias inválidas ⇒ 400 sin escrituras", () => {
  it("máximo+0.01, tercer decimal, number y exponente (orden y transfer) no escriben", async () => {
    const userId = await freshUser();
    const ordersBefore = await countAllOrders();
    const eventsBefore = await countAllEvents();

    const instrument = SEED_INSTRUMENT_PAMP_ID;
    const invalidPricedOrders: readonly Record<string, unknown>[] = [
      { instrumentId: instrument, side: "BUY", type: "LIMIT", size: 1, price: MAX_PLUS_CENT },
      { instrumentId: instrument, side: "BUY", type: "LIMIT", size: 1, price: "1.234" },
      { instrumentId: instrument, side: "BUY", type: "LIMIT", size: 1, price: 100.5 },
      { instrumentId: instrument, side: "BUY", type: "LIMIT", size: 1, price: "1e5" },
    ];
    for (const payload of invalidPricedOrders) {
      expectErrorCode(await postOrder(userId, payload), 400, "VALIDATION_ERROR");
    }

    const invalidAmountOrders: readonly Record<string, unknown>[] = [
      { instrumentId: instrument, side: "BUY", type: "LIMIT", amountArs: MAX_PLUS_CENT, price: "1.00" },
      { instrumentId: instrument, side: "BUY", type: "LIMIT", amountArs: "1.234", price: "1.00" },
      { instrumentId: instrument, side: "BUY", type: "LIMIT", amountArs: 123.45, price: "1.00" },
      { instrumentId: instrument, side: "BUY", type: "LIMIT", amountArs: "1e5", price: "1.00" },
    ];
    for (const payload of invalidAmountOrders) {
      expectErrorCode(await postOrder(userId, payload), 400, "VALIDATION_ERROR");
    }

    expectErrorCode(
      await postOrder(userId, {
        instrumentId: instrument,
        side: "BUY",
        type: "LIMIT",
        size: 1.5,
        price: "1.00",
      }),
      400,
      "VALIDATION_ERROR",
    );

    const invalidTransfers: readonly Record<string, unknown>[] = [
      { amountArs: MAX_PLUS_CENT, side: "CASH_IN" },
      { amountArs: "1.234", side: "CASH_IN" },
      { amountArs: 123.45, side: "CASH_IN" },
      { amountArs: "1e5", side: "CASH_IN" },
    ];
    for (const payload of invalidTransfers) {
      expectErrorCode(
        await postTransfer(userId, payload),
        400,
        "VALIDATION_ERROR",
      );
    }

    expect(await countOrdersForUser(userId)).toBe(0);
    expect(await countEventsForUser(userId)).toBe(0);
    expect(await countAllOrders()).toBe(ordersBefore);
    expect(await countAllEvents()).toBe(eventsBefore);
  });
});

// ---------------------------------------------------------------------------
// 3 · CASH_OUT: insuficiente y concurrencia con lock real
// ---------------------------------------------------------------------------

describe("3 · CASH_OUT insuficiente y concurrencia", () => {
  it("0.01 sobre disponible 0 ⇒ 201 REJECTED INSUFFICIENT_FUNDS sin débito", async () => {
    const userId = await freshUser();
    const res = await postTransfer(userId, {
      amountArs: "0.01",
      side: "CASH_OUT",
    });

    expect(res.status).toBe(201);
    const body = orderBody(res);
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("INSUFFICIENT_FUNDS");
    expect(body["size"]).toBe("0.01");
    expect(body["filledPrice"]).toBeNull();

    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchOrderRow(orderId as number);
    expect(row?.status).toBe("REJECTED");
    expect(row?.side).toBe("CASH_OUT");
    expect(row?.size).toBe("0.01");

    const events = await fetchOrderEvents(orderId as number);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("REJECTED");
    expect(events[0]?.reason).toBe("INSUFFICIENT_FUNDS");
    expect(events[0]?.metadata?.["requiredArs"]).toBe("0.01");
    expect(events[0]?.metadata?.["cashAvailableArs"]).toBe("0.00");

    const portfolio = await getPortfolio(userId);
    expect(portfolio.cash).toBe("0.00");
    expect(portfolio.totalAccountValue).toBe("0.00");
    expect(await countOrdersForUser(userId)).toBe(1);
    expect(await countEventsForUser(userId)).toBe(1);
  });

  it("dos CASH_OUT concurrentes de 0.01 con fondos 0.01 ⇒ una FILLED y una REJECTED, saldo 0.00", async () => {
    const userId = await freshUser();
    await cashIn(userId, "0.01");

    const responses = await Promise.all([
      postTransfer(userId, { amountArs: "0.01", side: "CASH_OUT" }),
      postTransfer(userId, { amountArs: "0.01", side: "CASH_OUT" }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(201);
    }
    const bodies = responses.map((res) => orderBody(res));
    const statuses = bodies.map((body) => body["status"]).sort();
    expect(statuses).toEqual(["FILLED", "REJECTED"]);
    expect(bodies[0]?.["id"]).not.toBe(bodies[1]?.["id"]);

    const rejected = bodies.find((body) => body["status"] === "REJECTED");
    expect(rejected?.["reason"]).toBe("INSUFFICIENT_FUNDS");

    for (const body of bodies) {
      const orderId = body["id"];
      expect(typeof orderId).toBe("number");
      expect(await fetchOrderEvents(orderId as number)).toHaveLength(1);
    }

    const portfolio = await getPortfolio(userId);
    expect(portfolio.cash).toBe("0.00");
    // CASH_IN de fondos + los dos CASH_OUT: una fila y un evento por orden.
    expect(await countOrdersForUser(userId)).toBe(3);
    expect(await countEventsForUser(userId)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4 · Idempotencia cash nueva
// ---------------------------------------------------------------------------

describe("4 · idempotencia cash", () => {
  it("misma key 123.01 → 123.99 ⇒ 409 sin movimiento ni evento extra", async () => {
    const userId = await freshUser();
    const key = "lm-acceptance-key-conflict";

    const first = await postTransfer(
      userId,
      { amountArs: "123.01", side: "CASH_IN" },
      key,
    );
    expect(first.status).toBe(201);
    const firstId = orderBody(first)["id"];

    const conflict = await postTransfer(
      userId,
      { amountArs: "123.99", side: "CASH_IN" },
      key,
    );
    expectErrorCode(conflict, 409, "IDEMPOTENCY_CONFLICT");

    expect(await countOrdersWithIdempotencyKey(userId, key)).toBe(1);
    expect(await countOrdersForUser(userId)).toBe(1);
    expect(await countEventsForUser(userId)).toBe(1);
    expect(await fetchOrderEvents(firstId as number)).toHaveLength(1);
    expect((await getPortfolio(userId)).cash).toBe("123.01");
  });

  it('"123.0" y "123.00" son el mismo monto: misma orden, sin evento extra', async () => {
    const userId = await freshUser();
    const key = "lm-acceptance-key-canonical";

    const first = await postTransfer(
      userId,
      { amountArs: "123.00", side: "CASH_IN" },
      key,
    );
    expect(first.status).toBe(201);
    const firstId = orderBody(first)["id"];

    const replay = await postTransfer(
      userId,
      { amountArs: "123.0", side: "CASH_IN" },
      key,
    );
    expect(replay.status).toBe(201);
    expect(orderBody(replay)["id"]).toBe(firstId);
    expect(cashAmountOf(replay)).toBe("123.00");

    expect(await countOrdersWithIdempotencyKey(userId, key)).toBe(1);
    expect(await fetchOrderEvents(firstId as number)).toHaveLength(1);
    expect((await getPortfolio(userId)).cash).toBe("123.00");
  });

  it("dos submits simultáneos con la misma key ⇒ una fila y un solo efecto", async () => {
    const userId = await freshUser();
    const key = "lm-acceptance-key-concurrent";
    const payload = { amountArs: "50.00", side: "CASH_IN" };

    const responses = await Promise.all([
      postTransfer(userId, payload, key),
      postTransfer(userId, payload, key),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(201);
    }
    const ids = responses.map((res) => orderBody(res)["id"]);
    expect(ids[0]).toBe(ids[1]);

    expect(await countOrdersWithIdempotencyKey(userId, key)).toBe(1);
    expect(await countEventsForUser(userId)).toBe(1);
    expect(await fetchOrderEvents(ids[0] as number)).toHaveLength(1);
    expect((await getPortfolio(userId)).cash).toBe("50.00");
  });
});

// ---------------------------------------------------------------------------
// 5 · Idempotencia HISTÓRICA (evidencia en metadata.amountArs)
// ---------------------------------------------------------------------------

describe("5 · replays históricos de cash", () => {
  it("key histórica 123.45 con size 123: replay devuelve 123.00, sin regalar 0.45", async () => {
    const userId = await freshUser();
    const key = "lm-acceptance-historical-123";
    const orderId = await insertHistoricalCash({
      userId,
      storedAmount: "123",
      status: "FILLED",
      idempotencyKey: key,
      metadata: { ticker: "ARS", amountArs: "123.45" },
      eventType: "ACCEPTED",
      reason: null,
    });

    expect((await getPortfolio(userId)).cash).toBe("123.00");

    const replay = await postTransfer(
      userId,
      { amountArs: "123.45", side: "CASH_IN" },
      key,
    );
    expect(replay.status).toBe(201);
    const body = orderBody(replay);
    expect(body["id"]).toBe(orderId);
    expect(body["status"]).toBe("FILLED");
    expect(body["size"]).toBe("123.00");

    const row = await fetchOrderRow(orderId);
    expect(row?.size).toBe("123.00");
    expect(await fetchOrderEvents(orderId)).toHaveLength(1);
    expect((await getPortfolio(userId)).cash).toBe("123.00");

    expectErrorCode(
      await postTransfer(
        userId,
        { amountArs: "123.99", side: "CASH_IN" },
        key,
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expectErrorCode(
      await postTransfer(
        userId,
        { amountArs: "123.00", side: "CASH_IN" },
        key,
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await countOrdersForUser(userId)).toBe(1);
    expect(await fetchOrderEvents(orderId)).toHaveLength(1);

    const newKey = await postTransfer(
      userId,
      { amountArs: "123.45", side: "CASH_IN" },
      "lm-acceptance-historical-new-key",
    );
    expect(newKey.status).toBe(201);
    expect(cashAmountOf(newKey)).toBe("123.45");
    const newId = orderBody(newKey)["id"];
    expect((await fetchOrderRow(newId as number))?.size).toBe("123.45");
    expect((await getPortfolio(userId)).cash).toBe("246.45");
    expect(await countEventsForUser(userId)).toBe(2);
  });

  it("evidencia ausente o malformada ⇒ 409 aunque el retry iguale el size guardado", async () => {
    const userId = await freshUser();
    const malformedKey = "lm-acceptance-hist-malformed";
    const missingKey = "lm-acceptance-hist-missing";

    await insertHistoricalCash({
      userId,
      storedAmount: "123",
      status: "FILLED",
      idempotencyKey: malformedKey,
      metadata: { ticker: "ARS", amountArs: "123.456" },
      eventType: "ACCEPTED",
      reason: null,
    });
    await insertHistoricalCash({
      userId,
      storedAmount: "123",
      status: "FILLED",
      idempotencyKey: missingKey,
      metadata: { ticker: "ARS" },
      eventType: "ACCEPTED",
      reason: null,
    });

    expectErrorCode(
      await postTransfer(
        userId,
        { amountArs: "123.00", side: "CASH_IN" },
        malformedKey,
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expectErrorCode(
      await postTransfer(
        userId,
        { amountArs: "123.00", side: "CASH_IN" },
        missingKey,
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );

    expect(await countOrdersForUser(userId)).toBe(2);
    expect(await countEventsForUser(userId)).toBe(2);
    expect((await getPortfolio(userId)).cash).toBe("246.00");
  });

  it("ZERO_SIZE histórico (0, REJECTED, meta 0.45) sigue REJECTED sin mover fondos", async () => {
    const userId = await freshUser();
    const key = "lm-acceptance-hist-zero";
    const orderId = await insertHistoricalCash({
      userId,
      storedAmount: "0",
      status: "REJECTED",
      idempotencyKey: key,
      metadata: { ticker: "ARS", amountArs: "0.45" },
      eventType: "REJECTED",
      reason: "ZERO_SIZE",
    });

    const replay = await postTransfer(
      userId,
      { amountArs: "0.45", side: "CASH_IN" },
      key,
    );
    expect(replay.status).toBe(201);
    const body = orderBody(replay);
    expect(body["id"]).toBe(orderId);
    expect(body["status"]).toBe("REJECTED");
    expect(body["size"]).toBe("0.00");

    const row = await fetchOrderRow(orderId);
    expect(row?.status).toBe("REJECTED");
    expect(row?.size).toBe("0.00");
    const events = await fetchOrderEvents(orderId);
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("ZERO_SIZE");
    expect((await getPortfolio(userId)).cash).toBe("0.00");
    expect(await countOrdersForUser(userId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6 · Sizing defensivo y precio máximo
// ---------------------------------------------------------------------------

describe("6 · sizing y precio máximo", () => {
  it("BUY amountArs 2147483648.00 a precio 1.00 ⇒ 400 sin orden/evento", async () => {
    const userId = await freshUser();
    const ordersBefore = await countAllOrders();
    const eventsBefore = await countAllEvents();

    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      amountArs: "2147483648.00",
      price: "1.00",
    });

    expectErrorCode(res, 400, "VALIDATION_ERROR");
    expect(await countOrdersForUser(userId)).toBe(0);
    expect(await countAllOrders()).toBe(ordersBefore);
    expect(await countAllEvents()).toBe(eventsBefore);
  });

  it("price máximo vuelve exacto en LIMIT NEW y en REJECTED; price×size > máximo no es error", async () => {
    const newUser = await freshUser();
    await cashIn(newUser, MAX);

    const accepted = await postOrder(newUser, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 1,
      price: MAX,
    });
    expect(accepted.status).toBe(201);
    const acceptedBody = orderBody(accepted);
    expect(acceptedBody["status"]).toBe("NEW");
    expect(acceptedBody["price"]).toBe(MAX);
    expect((await fetchOrderRow(acceptedBody["id"] as number))?.price).toBe(MAX);
    const acceptedPortfolio = await getPortfolio(newUser);
    expect(acceptedPortfolio.reservedCash).toBe(MAX);
    expect(acceptedPortfolio.cash).toBe("0.00");

    // producto price × size = 2×máximo > máximo de columna: sigue siendo un
    // rechazo de NEGOCIO (201), nunca 400/500.
    const rejectedUser = await freshUser();
    await cashIn(rejectedUser, MAX);
    const rejected = await postOrder(rejectedUser, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 2,
      price: MAX,
    });
    expect(rejected.status).toBe(201);
    const rejectedBody = orderBody(rejected);
    expect(rejectedBody["status"]).toBe("REJECTED");
    expect(rejectedBody["reason"]).toBe("INSUFFICIENT_FUNDS");
    expect(rejectedBody["price"]).toBe(MAX);
    const rejectedPortfolio = await getPortfolio(rejectedUser);
    expect(rejectedPortfolio.cash).toBe(MAX);
    expect(rejectedPortfolio.reservedCash).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 7 · Agregados por encima del máximo + reservas + quantity heredada
// ---------------------------------------------------------------------------

describe("7 · agregados y reservas", () => {
  it("dos cash máximos: cash y totalAccountValue agregados > máximo, exactos", async () => {
    const userId = await freshUser();
    await cashIn(userId, MAX);
    await cashIn(userId, MAX);

    const portfolio = await getPortfolio(userId);
    expect(portfolio.cash).toBe(TWO_MAX);
    expect(portfolio.reservedCash).toBe("0.00");
    expect(portfolio.totalAccountValue).toBe(TWO_MAX);
  });

  it("reserva BUY precio×máximo×2 > máximo exacta; el total no cambia al reservar ni cancelar", async () => {
    const userId = await freshUser();
    await cashIn(userId, MAX);
    await cashIn(userId, MAX);
    await cashIn(userId, MAX);
    const before = await getPortfolio(userId);
    expect(before.cash).toBe(THREE_MAX);
    expect(before.totalAccountValue).toBe(THREE_MAX);

    const accepted = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 2,
      price: MAX,
    });
    expect(accepted.status).toBe(201);
    const body = orderBody(accepted);
    expect(body["status"]).toBe("NEW");
    const orderId = body["id"];
    expect(typeof orderId).toBe("number");

    const reserved = await getPortfolio(userId);
    expect(reserved.reservedCash).toBe(TWO_MAX);
    expect(reserved.cash).toBe(MAX);
    expect(reserved.totalAccountValue).toBe(THREE_MAX);

    const cancelled = await request(app).delete(
      `/api/orders/${String(orderId)}`,
    );
    expect(cancelled.status).toBe(200);
    expect(orderBody(cancelled)["status"]).toBe("CANCELLED");

    const afterCancel = await getPortfolio(userId);
    expect(afterCancel.reservedCash).toBe("0.00");
    expect(afterCancel.cash).toBe(THREE_MAX);
    expect(afterCancel.totalAccountValue).toBe(THREE_MAX);
  });

  it("portfolio heredado: quantity es string y la posición negativa del seed sigue -10", async () => {
    const portfolio = await getPortfolio(SEED_USER_EMILIANO_ID);
    const quantities = new Map(
      portfolio.positions.map((position) => [position.ticker, position]),
    );

    expect(quantities.get("PAMP")?.quantity).toBe("40");
    expect(quantities.get("METR")?.quantity).toBe("500");
    expect(quantities.get("BMA")?.quantity).toBe("-10");
    expect(portfolio.cash).toBe("627500.00");
    expect(portfolio.reservedCash).toBe("125500.00");
  });
});

// ---------------------------------------------------------------------------
// 8 · Rollback real de orden + evento (repo envuelto)
// ---------------------------------------------------------------------------

describe("8 · rollback real ante fallo de auditoría", () => {
  it("trading: el throw posterior al evento revierte la orden y no mueve cash", async () => {
    const userId = await freshUser();
    await cashIn(userId, "10.00");
    const ordersBefore = await countOrdersForUser(userId);
    const eventsBefore = await countEventsForUser(userId);

    const res = await request(rollbackApp)
      .post(`/api/users/${String(userId)}/orders`)
      .send({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "BUY",
        type: "LIMIT",
        size: 1,
        price: "1.00",
      });

    expectErrorCode(res, 500, "INTERNAL_ERROR");
    expect(await countOrdersForUser(userId)).toBe(ordersBefore);
    expect(await countEventsForUser(userId)).toBe(eventsBefore);
    expect((await getPortfolio(userId)).cash).toBe("10.00");
  });

  it("cash: el throw posterior al evento revierte la transferencia completa", async () => {
    const userId = await freshUser();

    const res = await request(rollbackApp)
      .post(`/api/users/${String(userId)}/transfers`)
      .send({ amountArs: "12.34", side: "CASH_IN" });

    expectErrorCode(res, 500, "INTERNAL_ERROR");
    expect(await countOrdersForUser(userId)).toBe(0);
    expect(await countEventsForUser(userId)).toBe(0);
    expect((await getPortfolio(userId)).cash).toBe("0.00");
  });
});
