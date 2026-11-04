// Célula G — tests funcionales UC-5 (POST /api/users/:userId/transfers).
//
// Corren contra la app LOCAL (buildTransfersTestApp: router de transfers +
// router de portfolio) con los repos Prisma REALES sobre la DB AISLADA
// cocos_challenge_transfer (self-reset en beforeAll — ver ./support.ts).
//
// AISLAMIENTO POR TEST: cada test que muta usa un USUARIO FRESCO con sus
// propias fixtures (cash/reservas), así ningún test depende del orden de
// corrida ni del estado que otro dejó. El caso clave (CASH_OUT 630000)
// reproduce en un usuario fresco el estado golden del seed user 1:
// settled 753000 − reservado 125500 ⇒ DISPONIBLE 627500
// (tests/helpers/fixtures.ts, SEED_USER_1_PORTFOLIO).
//
// El mapper de B ya hace COALESCE(filledPrice, price) (GATE 3): las FILLED
// creadas por la API (ejecución en filledPrice) se leen bien como las
// legacy del seed (price) — las transferencias persisten price = 1.00 Y
// filledPrice = 1.00, así que proyectan size × 1.00 = pesos en ambas eras.
//
// Dinero (AGENTS.md): esperados con Decimal desde strings, nunca float.

import request from "supertest";
import type { Response } from "supertest";
import {
  IDEMPOTENCY_KEY_HEADER,
  type PortfolioResponse,
} from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENT_ARS_ID,
  SEED_INSTRUMENT_PAMP_ID,
  SEED_USER_1_PORTFOLIO,
} from "../../helpers/fixtures.js";
import {
  buildTransfersTestApp,
  closeTransfersDbPool,
  countTransfersOrders,
  countTransfersOrdersWithIdempotencyKey,
  expectedCashAfter,
  expectMoneyArs,
  fetchTransfersOrderEvents,
  fetchTransfersOrderRow,
  insertTestCashIn,
  insertTestRestingBuy,
  insertTestUser,
  resetTransfersDatabase,
} from "./support.js";

// El reset (drop/create + migrate deploy + seed) es lento; los tests no.
jest.setTimeout(30_000);

const app = buildTransfersTestApp();

const getPortfolio = async (userId: number): Promise<PortfolioResponse> => {
  const res = await request(app).get(
    `/api/users/${String(userId)}/portfolio`,
  );
  return res.body as PortfolioResponse;
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

// ---------------------------------------------------------------------
// Fixtures de usuario fresco (aislamiento por test)
// ---------------------------------------------------------------------

let userSeq = 0;

/** Usuario fresco, opcionalmente con cash settled (CASH_IN de fixture). */
const freshUser = async (cashSettledArs?: string): Promise<number> => {
  userSeq += 1;
  const userId = await insertTestUser(
    `celle-g-${String(userSeq)}-${String(Date.now())}@test.local`,
  );
  if (cashSettledArs !== undefined) {
    await insertTestCashIn(userId, cashSettledArs);
  }
  return userId;
};

/**
 * Usuario fresco que reproduce el estado golden del seed user 1
 * (SEED_USER_1_PORTFOLIO): cash settled 753000 (CASH_IN 753000 × 1.00) −
 * reserva 125500 (BUY NEW 500 × 251) ⇒ DISPONIBLE 627500.
 */
const freshGoldenUser = async (): Promise<number> => {
  const userId = await freshUser(SEED_USER_1_PORTFOLIO.cashSettledArs);
  await insertTestRestingBuy(
    userId,
    SEED_INSTRUMENT_PAMP_ID,
    500,
    "251.00", // 500 × 251 = 125500 de reserva
  );
  return userId;
};

beforeAll(async () => {
  // DB de esta célula al estado del seed: suite autocontenida.
  await resetTransfersDatabase();
}, 240_000);

afterAll(async () => {
  await closeTransfersDbPool();
});

// ---------------------------------------------------------------------
// CASH_IN (depósito)
// ---------------------------------------------------------------------

describe("UC-5 transfers · CASH_IN", () => {
  it("⇒ 201 FILLED inmediata (sin validación de fondos) y el DISPONIBLE del portfolio sube amountArs", async () => {
    const userId = await freshUser("10000.00");
    const before = await getPortfolio(userId);

    const res = await postTransfer(userId, {
      amountArs: 5000,
      side: "CASH_IN",
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("FILLED");
    expect(body["side"]).toBe("CASH_IN");
    expect(body["type"]).toBe("MARKET"); // convención del seed para las filas CASH
    expect(body["timeInForce"]).toBe("GTC");
    expect(body["instrumentId"]).toBe(SEED_INSTRUMENT_ARS_ID); // la MONEDA del cash
    expect(body["size"]).toBe(5000); // size = pesos
    expect(body["reason"]).toBeNull(); // no hubo rechazo
    expectMoneyArs(body["price"], "1.00"); // un peso por peso
    expectMoneyArs(body["filledPrice"], "1.00"); // ejecución inmediata a 1.00
    expect(typeof body["filledAt"]).toBe("string");
    expect(typeof body["datetime"]).toBe("string");

    // Persistida EXACTAMENTE como la convención del seed exige:
    // price = 1.00 (sin esto deriveCash rompería la proyección de cash)
    // y la ejecución en filledPrice.
    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchTransfersOrderRow(orderId as number);
    expect(row?.status).toBe("FILLED");
    expect(row?.side).toBe("CASH_IN");
    expect(row?.size).toBe(5000);
    expect(row?.price).toBe("1.00");
    expect(row?.["filledPrice"]).toBe("1.00");

    // Evento de auditoría en la MISMA tx (convención de E: ACCEPTED al FILLED).
    const events = await fetchTransfersOrderEvents(orderId as number);
    expect(events.some((event) => event.eventType === "ACCEPTED")).toBe(true);

    // Delta de cash VISIBLE en el portfolio: el disponible sube 5000.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "5000.00"));
  });

  it("amountArs < 1 peso ⇒ size 0 ⇒ 201 REJECTED ZERO_SIZE (regla de sizing de DECISIONS.md)", async () => {
    const userId = await freshUser("1000.00");
    const res = await postTransfer(userId, {
      amountArs: 0.5,
      side: "CASH_IN",
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("ZERO_SIZE");
    expect(body["size"]).toBe(0);

    const events = await fetchTransfersOrderEvents(body["id"] as number);
    expect(
      events.some(
        (event) => event.eventType === "REJECTED" && event.reason === "ZERO_SIZE",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------
// CASH_OUT (extracción) — valida contra el DISPONIBLE (settled − reservas)
// ---------------------------------------------------------------------

describe("UC-5 transfers · CASH_OUT", () => {
  it("con disponible suficiente ⇒ 201 FILLED y el DISPONIBLE baja amountArs", async () => {
    const userId = await freshUser("10000.00");
    const before = await getPortfolio(userId);

    const res = await postTransfer(userId, {
      amountArs: 5000,
      side: "CASH_OUT",
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("FILLED");
    expect(body["side"]).toBe("CASH_OUT");
    expect(body["size"]).toBe(5000);
    expect(body["reason"]).toBeNull();
    expectMoneyArs(body["filledPrice"], "1.00");

    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchTransfersOrderRow(orderId as number);
    expect(row?.status).toBe("FILLED");
    expect(row?.price).toBe("1.00");
    expect(row?.["filledPrice"]).toBe("1.00");

    const events = await fetchTransfersOrderEvents(orderId as number);
    expect(events.some((event) => event.eventType === "ACCEPTED")).toBe(true);

    // Delta de cash VISIBLE en el portfolio: el disponible baja 5000.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "-5000.00"));
  });

  it("mayor que el DISPONIBLE (700000 > 627500) ⇒ 201 REJECTED INSUFFICIENT_FUNDS persistida + evento, SIN efecto en cash", async () => {
    // Estado golden del seed user 1 en un usuario fresco: settled 753000,
    // reservado 125500 ⇒ disponible 627500.
    const userId = await freshGoldenUser();
    const before = await getPortfolio(userId);
    expectMoneyArs(before.cash, "627500.00"); // settled 753000 − reservado 125500
    expectMoneyArs(before.reservedCash, "125500.00");

    const res = await postTransfer(userId, {
      amountArs: 700000,
      side: "CASH_OUT",
    });

    expect(res.status).toBe(201); // 201 TAMBIÉN para REJECTED persistida
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("INSUFFICIENT_FUNDS");
    expect(body["size"]).toBe(700000); // el monto pedido, no 0
    expect(body["filledPrice"]).toBeNull();
    expect(body["filledAt"]).toBeNull();

    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchTransfersOrderRow(orderId as number);
    expect(row?.status).toBe("REJECTED");
    expect(row?.side).toBe("CASH_OUT");
    expect(row?.size).toBe(700000);
    expect(row?.["filledPrice"]).toBeNull();

    // Evento REJECTED con la razón Y la metadata del porqué (disponible
    // y requerido, como strings Decimal).
    const events = await fetchTransfersOrderEvents(orderId as number);
    const rejected = events.find((event) => event.eventType === "REJECTED");
    expect(rejected?.reason).toBe("INSUFFICIENT_FUNDS");
    expect(rejected?.metadata?.["cashAvailableArs"]).toBe("627500.00");
    expect(rejected?.metadata?.["requiredArs"]).toBe("700000.00");

    // SIN efecto en cash: ni el disponible ni el reservado se mueven.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "0.00"));
    expectMoneyArs(after.reservedCash, expectedCashAfter(before.reservedCash, "0.00"));
  });

  it("CLAVE: 630000 — MENOR que el settled (753000) PERO MAYOR que el disponible (627500) ⇒ REJECTED", async () => {
    // Si la validación fuera contra el SETTLED (753000), esta extracción de
    // 630000 pasaría; contra el DISPONIBLE (settled − reservas = 627500)
    // se rechaza — la prueba clave de que las reservas cuentan.
    const userId = await freshGoldenUser();
    const before = await getPortfolio(userId);
    expectMoneyArs(before.cash, "627500.00");

    const res = await postTransfer(userId, {
      amountArs: 630000,
      side: "CASH_OUT",
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("INSUFFICIENT_FUNDS");
    expect(body["size"]).toBe(630000);

    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchTransfersOrderRow(orderId as number);
    expect(row?.status).toBe("REJECTED");

    const events = await fetchTransfersOrderEvents(orderId as number);
    const rejected = events.find((event) => event.eventType === "REJECTED");
    expect(rejected?.reason).toBe("INSUFFICIENT_FUNDS");
    expect(rejected?.metadata?.["cashAvailableArs"]).toBe("627500.00");
    expect(rejected?.metadata?.["requiredArs"]).toBe("630000.00");

    // Sin débito: el disponible sigue en 627500.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, "627500.00");
  });

  it("mayor incluso que el settled (800000 > 753000) ⇒ REJECTED igual (no hay saldo que alcance)", async () => {
    const userId = await freshGoldenUser();
    const res = await postTransfer(userId, {
      amountArs: 800000,
      side: "CASH_OUT",
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("INSUFFICIENT_FUNDS");
  });
});

// ---------------------------------------------------------------------
// Errores del borde (400/404) — SIN registro
// ---------------------------------------------------------------------

describe("UC-5 transfers · errores del borde", () => {
  it("amountArs ≤ 0 ⇒ 400 VALIDATION_ERROR SIN registro", async () => {
    const userId = await freshUser();
    const before = await countTransfersOrders(userId);

    for (const amountArs of [0, -100]) {
      const res = await postTransfer(userId, {
        amountArs,
        side: "CASH_IN",
      });
      expect(res.status).toBe(400);
      expect(
        (res.body as { error?: { code?: unknown } }).error?.code,
      ).toBe("VALIDATION_ERROR");
    }

    expect(await countTransfersOrders(userId)).toBe(before); // sin registro
  });

  it("side de trading (BUY) ⇒ 400 SIN registro", async () => {
    const userId = await freshUser();
    const before = await countTransfersOrders(userId);

    const res = await postTransfer(userId, {
      amountArs: 5000,
      side: "BUY",
    });

    expect(res.status).toBe(400);
    expect(
      (res.body as { error?: { code?: unknown } }).error?.code,
    ).toBe("VALIDATION_ERROR");
    expect(await countTransfersOrders(userId)).toBe(before);
  });

  it("sin amountArs ⇒ 400 SIN registro", async () => {
    const userId = await freshUser();
    const before = await countTransfersOrders(userId);

    const res = await postTransfer(userId, { side: "CASH_IN" });

    expect(res.status).toBe(400);
    expect(await countTransfersOrders(userId)).toBe(before);
  });

  it("usuario inexistente ⇒ 404 USER_NOT_FOUND", async () => {
    const res = await postTransfer(99999, {
      amountArs: 5000,
      side: "CASH_IN",
    });

    expect(res.status).toBe(404);
    expect(
      (res.body as { error?: { code?: unknown } }).error?.code,
    ).toBe("USER_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------
// Idempotencia
// ---------------------------------------------------------------------

describe("UC-5 transfers · idempotencia", () => {
  it("misma key + mismo payload ⇒ la MISMA orden, sin duplicar el efecto en cash", async () => {
    const userId = await freshUser("10000.00");
    const key = "celle-g-idem-secuencial";
    const before = await getPortfolio(userId);

    const firstRes = await postTransfer(
      userId,
      { amountArs: 5000, side: "CASH_IN" },
      key,
    );
    expect(firstRes.status).toBe(201);
    const first = firstRes.body as Record<string, unknown>;
    expect(first["status"]).toBe("FILLED");

    const secondRes = await postTransfer(
      userId,
      { amountArs: 5000, side: "CASH_IN" },
      key,
    );
    expect(secondRes.status).toBe(201); // replay: 201 con la original
    expect((secondRes.body as Record<string, unknown>)["id"]).toBe(first["id"]);

    expect(await countTransfersOrdersWithIdempotencyKey(userId, key)).toBe(1);

    // Un SOLO efecto en cash: el disponible sube 5000 una vez.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "5000.00"));
  });

  it("misma key + payload DISTINTO ⇒ 409 IDEMPOTENCY_CONFLICT sin nueva orden", async () => {
    const userId = await freshUser("10000.00");
    const key = "celle-g-idem-conflicto";

    const first = await postTransfer(
      userId,
      { amountArs: 5000, side: "CASH_IN" },
      key,
    );
    expect(first.status).toBe(201);

    const before = await countTransfersOrders(userId);
    const res = await postTransfer(
      userId,
      { amountArs: 7000, side: "CASH_IN" }, // mismo key, OTRO monto
      key,
    );

    expect(res.status).toBe(409);
    const errorBody = res.body as { error?: { code?: unknown } };
    expect(errorBody.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await countTransfersOrders(userId)).toBe(before); // sin nueva orden
  });

  it("doble-submit CONCURRENTE con la misma key ⇒ EXACTAMENTE una orden (claim idempotente)", async () => {
    const userId = await freshUser("10000.00");
    const key = "celle-g-idem-concurrente";
    const before = await getPortfolio(userId);

    const settled = await Promise.allSettled([
      postTransfer(userId, { amountArs: 5000, side: "CASH_IN" }, key),
      postTransfer(userId, { amountArs: 5000, side: "CASH_IN" }, key),
    ]);

    const bodies = settled.map((result) => {
      expect(result.status).toBe("fulfilled");
      return (result as PromiseFulfilledResult<Response>).value.body as Record<
        string,
        unknown
      >;
    });
    expect(bodies).toHaveLength(2);
    // El lock por usuario serializa: una CREATED y una REPLAY de la MISMA orden.
    expect(bodies[0]?.["status"]).toBe("FILLED");
    expect(bodies[0]?.["id"]).toBe(bodies[1]?.["id"]); // misma orden ambas veces
    expect(await countTransfersOrdersWithIdempotencyKey(userId, key)).toBe(1);

    // Un SOLO efecto en cash (un solo depósito de 5000).
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "5000.00"));
  });
});

// ---------------------------------------------------------------------
// Concurrencia sobre el cash (lock por usuario)
// ---------------------------------------------------------------------

describe("UC-5 transfers · concurrencia sobre el cash", () => {
  it("dos CASH_OUT simultáneas que JUNTAS exceden el disponible ⇒ EXACTAMENTE una FILLED y una REJECTED", async () => {
    const userId = await freshUser("100000.00"); // 2 × 60000 > 100000
    const before = await getPortfolio(userId);

    const settled = await Promise.allSettled([
      postTransfer(userId, { amountArs: 60000, side: "CASH_OUT" }),
      postTransfer(userId, { amountArs: 60000, side: "CASH_OUT" }),
    ]);

    const bodies = settled.map((result) => {
      expect(result.status).toBe("fulfilled");
      return (result as PromiseFulfilledResult<Response>).value.body as Record<
        string,
        unknown
      >;
    });

    // El lock serializa: la primera ve 100000 y pasa; la segunda ya ve el
    // cash debitado (40000 < 60000) y queda REJECTED.
    const statuses = bodies.map((body) => body["status"]).sort();
    expect(statuses).toEqual(["FILLED", "REJECTED"]);
    expect(bodies[0]?.["id"]).not.toBe(bodies[1]?.["id"]); // dos órdenes distintas

    const rejected = bodies.find((body) => body["status"] === "REJECTED");
    expect(rejected?.["reason"]).toBe("INSUFFICIENT_FUNDS");

    const orderId = rejected?.["id"];
    expect(typeof orderId).toBe("number");
    const events = await fetchTransfersOrderEvents(orderId as number);
    const rejectedEvent = events.find(
      (event) => event.eventType === "REJECTED",
    );
    expect(rejectedEvent?.reason).toBe("INSUFFICIENT_FUNDS");
    expect(rejectedEvent?.metadata?.["cashAvailableArs"]).toBe("40000.00");
    expect(rejectedEvent?.metadata?.["requiredArs"]).toBe("60000.00");

    // Un SOLO débito: el disponible baja 60000 una sola vez.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "-60000.00"));
  });
});
