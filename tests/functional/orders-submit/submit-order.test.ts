// Célula E — tests funcionales UC-3 (POST /api/users/:userId/orders).
//
// Corren contra la app LOCAL (buildSubmitTestApp: buildOrdersRouter + router
// de portfolio) con los repos Prisma REALES sobre la DB AISLADA
// cocos_challenge_submit (self-reset en beforeAll — ver ./support.ts).
//
// Cobertura LIVIANA y propia: NO duplica la matriz de la Célula D
// (tests/functional/orders/**, 25 tests contra serverApp): acá se valida el
// cableo application+router+repos que esa matriz asumirá tras el merge.
//
// AISLAMIENTO POR TEST: cada test que CREA órdenes usa un USUARIO FRESCO
// (insertTestUser + CASH_IN de fixture). Motivo (QUESTION del reporte):
// mapSettledMovementRow (célula B) mapea `price` como precio de ejecución
// (semántica legacy del seed); las FILLED creadas por la API llevan la
// ejecución en `filledPrice` (DECISIONS.md) ⇒ cualquier lectura de
// movimientos tras un fill creado por la API rompe (CorruptRowError) hasta
// el fix de B. Con usuarios frescos el flujo de cada test arranca limpio y
// valida exactamente SU envío; los deltas de cash de los fills se proyectan
// por SQL con COALESCE("filledPrice", price) (ver sqlCashSettledArs).
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
  SEED_INSTRUMENT_BMA_ID,
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
  SEED_INSTRUMENTS_WITHOUT_MARKETDATA,
  SEED_REFERENCE_CLOSES,
  SEED_USER_EMILIANO_ID,
} from "../../helpers/fixtures.js";
import {
  buildSubmitTestApp,
  closeSubmitDbPool,
  costArs,
  countSubmitOrdersWithIdempotencyKey,
  expectedCashAfter,
  expectMoneyArs,
  fetchSubmitOrderEvents,
  fetchSubmitOrderRow,
  insertTestCashIn,
  insertTestUser,
  resetSubmitDatabase,
  sqlCashAfter,
  sqlCashSettledArs,
} from "./support.js";

// El reset (drop/create + migrate deploy + seed) es lento; los tests no.
jest.setTimeout(30_000);

/** Closes de referencia del seed (última fecha de marketdata por date). */
const REF = SEED_REFERENCE_CLOSES;
/** PGR — instrumento SIN marketdata en el seed (⇒ precio de referencia null). */
const PGR_ID = SEED_INSTRUMENTS_WITHOUT_MARKETDATA[0];

const app = buildSubmitTestApp();

/** Usuario fresco con cash liquidado (CASH_IN de fixture) — aislamiento por test. */
const freshUserWithCash = async (cashArs: string): Promise<number> => {
  const userId = await insertTestUser(`celle-e-${Date.now()}@test.local`);
  await insertTestCashIn(userId, cashArs);
  return userId;
};

const getPortfolio = async (userId: number): Promise<PortfolioResponse> => {
  const res = await request(app).get(
    `/api/users/${String(userId)}/portfolio`,
  );
  return res.body as PortfolioResponse;
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

beforeAll(async () => {
  // DB de esta célula al estado del seed: suite autocontenida.
  await resetSubmitDatabase();
}, 240_000);

afterAll(async () => {
  await closeSubmitDbPool();
});

// ---------------------------------------------------------------------------
// MARKET BUY
// ---------------------------------------------------------------------------

describe("UC-3 submit · MARKET BUY", () => {
  it("con fondos ⇒ 201 FILLED al precio de referencia (fila con price NULL y filledPrice = ref)", async () => {
    const userId = await freshUserWithCash("100000.00");
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 3,
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("FILLED");
    expect(body["side"]).toBe("BUY");
    expect(body["timeInForce"]).toBe("GTC"); // default del contrato
    expect(body["price"]).toBeNull(); // MARKET no lleva límite
    expect(body["reason"]).toBeNull();
    expect(typeof body["datetime"]).toBe("string");
    expect(typeof body["filledAt"]).toBe("string");
    expectMoneyArs(body["filledPrice"], REF.PAMP); // 925.85 exacto — el de referencia

    // Persistida EXACTAMENTE como la matriz D lo exige (caso 1):
    // price NULL (MARKET), filledPrice = ejecución.
    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchSubmitOrderRow(orderId as number);
    expect(row?.status).toBe("FILLED");
    expect(row?.size).toBe("3.00"); // NUMERIC(24,2): pg lo devuelve como string
    expect(row?.price).toBeNull();
    expect(row?.["filledPrice"]).toBe("925.85");

    // Delta de cash proyectado por SQL (COALESCE): debita size × ref.
    // El delta por el router de portfolio es trabajo de la matriz D tras el
    // fix de B (QUESTION del reporte).
    const afterCash = await sqlCashSettledArs(userId);
    expect(afterCash).toBe(sqlCashAfter("100000.00", `-${costArs(3, REF.PAMP)}`));
  });

  it("sin fondos ⇒ 201 REJECTED INSUFFICIENT_FUNDS persistida + evento, sin mover cash", async () => {
    const userId = await freshUserWithCash("1000.00");
    // 1000 × 925.85 = 925.850 > cash disponible (1000).
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 1000,
    });

    expect(res.status).toBe(201); // 201 TAMBIÉN para REJECTED persistida
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("INSUFFICIENT_FUNDS");
    expect(body["filledPrice"]).toBeNull();
    expect(body["filledAt"]).toBeNull();

    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const row = await fetchSubmitOrderRow(orderId as number);
    expect(row?.status).toBe("REJECTED");
    expect(row?.side).toBe("BUY");

    const events = await fetchSubmitOrderEvents(orderId as number);
    expect(
      events.some(
        (event) =>
          event.eventType === "REJECTED" &&
          event.reason === "INSUFFICIENT_FUNDS",
      ),
    ).toBe(true);

    // Sin reserva ni débito: el cash disponible no se mueve.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, "1000.00");
  });
});

// ---------------------------------------------------------------------------
// LIMIT GTC ⇒ NEW + reserva
// ---------------------------------------------------------------------------

describe("UC-3 submit · LIMIT GTC", () => {
  it("⇒ 201 NEW y la reserva es visible en el portfolio (cash ↓, reservedCash ↑)", async () => {
    const userId = await freshUserWithCash("100000.00");
    const before = await getPortfolio(userId);
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 2,
      price: "250", // sin timeInForce ⇒ default GTC
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("NEW"); // LIMIT GTC nunca se llena al enviar
    expect(body["reason"]).toBeNull();
    expectMoneyArs(body["price"], "250.00"); // price = límite enviado
    expect(body["filledPrice"]).toBeNull();

    const row = await fetchSubmitOrderRow(body["id"] as number);
    expect(row?.status).toBe("NEW");
    expect(row?.price).toBe("250.00");

    // Reserva implícita: el disponible baja 2 × 250 y el reservado sube 500.
    const reserve = costArs(2, "250.00");
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, `-${reserve}`));
    expectMoneyArs(
      after.reservedCash,
      expectedCashAfter(before.reservedCash, reserve),
    );
  });
});

// ---------------------------------------------------------------------------
// LIMIT IOC: cruce / no-cruce
// ---------------------------------------------------------------------------

describe("UC-3 submit · LIMIT IOC", () => {
  it("que cruza (BUY, límite ARRIBA del ref) ⇒ FILLED con filledPrice mejorado al ref", async () => {
    const userId = await freshUserWithCash("10000.00");
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: "950", // ref 925.85 ⇒ cruza ⇒ ejecuta a min(950, ref) = ref
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("FILLED");
    expect(body["timeInForce"]).toBe("IOC");
    expectMoneyArs(body["price"], "950.00"); // el límite queda en orders.price
    expectMoneyArs(body["filledPrice"], REF.PAMP); // mejora: al ref, no al límite

    const row = await fetchSubmitOrderRow(body["id"] as number);
    expect(row?.price).toBe("950.00");
    expect(row?.["filledPrice"]).toBe("925.85");

    // Debita 2 × ref (precio de ejecución), no 2 × límite.
    const afterCash = await sqlCashSettledArs(userId);
    expect(afterCash).toBe(
      sqlCashAfter("10000.00", `-${costArs(2, REF.PAMP)}`), // −1851.70
    );
  });

  it("que NO cruza ⇒ 201 CANCELLED NO_IMMEDIATE_MATCH + evento, sin reserva", async () => {
    const userId = await freshUserWithCash("10000.00");
    const before = await getPortfolio(userId);
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: "900", // ref 925.85 ⇒ no cruza
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("CANCELLED");
    expect(body["reason"]).toBe("NO_IMMEDIATE_MATCH");
    expect(body["filledPrice"]).toBeNull();
    expect(body["filledAt"]).toBeNull();

    const orderId = body["id"];
    expect(typeof orderId).toBe("number");
    const events = await fetchSubmitOrderEvents(orderId as number);
    expect(
      events.some(
        (event) =>
          event.eventType === "CANCELLED" &&
          event.reason === "NO_IMMEDIATE_MATCH",
      ),
    ).toBe(true);

    // Sin fills ni reserva: el disponible no se mueve.
    const after = await getPortfolio(userId);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "0.00"));
  });
});

// ---------------------------------------------------------------------------
// Idempotencia
// ---------------------------------------------------------------------------

describe("UC-3 submit · idempotencia", () => {
  const payload = {
    instrumentId: SEED_INSTRUMENT_METR_ID,
    side: "BUY",
    type: "LIMIT",
    size: 1,
    price: "210", // GTC: queda NEW (nunca fill ⇒ no toca movimientos)
  };

  it("misma key + mismo payload ⇒ la MISMA orden, sin duplicar ni reservar dos veces", async () => {
    const userId = await freshUserWithCash("5000.00");
    const key = "celle-e-idem-secuencial";
    const before = await getPortfolio(userId);

    const firstRes = await postOrder(userId, payload, key);
    expect(firstRes.status).toBe(201);
    const first = firstRes.body as Record<string, unknown>;
    expect(first["status"]).toBe("NEW");

    const secondRes = await postOrder(userId, payload, key);
    expect(secondRes.status).toBe(201);
    expect((secondRes.body as Record<string, unknown>)["id"]).toBe(first["id"]);

    expect(await countSubmitOrdersWithIdempotencyKey(userId, key)).toBe(1);

    // Un solo efecto en cash (una sola reserva de 1 × 210).
    const after = await getPortfolio(userId);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(1, "210.00")}`),
    );
  });

  it("misma key + payload DISTINTO ⇒ 409 IDEMPOTENCY_CONFLICT sin nueva orden", async () => {
    const userId = await freshUserWithCash("5000.00");
    const key = "celle-e-idem-conflicto";
    const first = await postOrder(userId, payload, key);
    expect(first.status).toBe(201);

    const before = await countSubmitOrdersWithIdempotencyKey(userId, key);
    const res = await postOrder(userId, { ...payload, size: 7 }, key);

    expect(res.status).toBe(409);
    const errorBody = res.body as { error?: { code?: unknown } };
    expect(errorBody.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await countSubmitOrdersWithIdempotencyKey(userId, key)).toBe(before);
  });

  it("doble-submit CONCURRENTE con la misma key ⇒ EXACTAMENTE una orden (claim idempotente)", async () => {
    const userId = await freshUserWithCash("5000.00");
    const key = "celle-e-idem-concurrente";
    const settled = await Promise.allSettled([
      postOrder(userId, payload, key),
      postOrder(userId, payload, key),
    ]);

    const bodies = settled.map((result) => {
      expect(result.status).toBe("fulfilled");
      return (result as PromiseFulfilledResult<Response>).value.body as Record<
        string,
        unknown
      >;
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.["status"]).toBe("NEW"); // CREATED y REPLAY: la misma NEW
    expect(bodies[0]?.["id"]).toBe(bodies[1]?.["id"]); // misma orden ambas veces
    expect(await countSubmitOrdersWithIdempotencyKey(userId, key)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rechazos de dominio (ZERO_SIZE / NO_PRICE / INSUFFICIENT_POSITION)
// ---------------------------------------------------------------------------

describe("UC-3 submit · rechazos de dominio", () => {
  it("amountArs menor que el ref ⇒ size 0 ⇒ 201 REJECTED ZERO_SIZE con size 0", async () => {
    const userId = await freshUserWithCash("10000.00");
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_BMA_ID,
      side: "BUY",
      type: "MARKET",
      amountArs: "100", // floor(100 / 1502.80) = 0
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("ZERO_SIZE");
    expect(body["size"]).toBe(0); // contrato: size 0 (no null)

    const row = await fetchSubmitOrderRow(body["id"] as number);
    expect(row?.status).toBe("REJECTED");
    expect(row?.size).toBe("0.00");

    const events = await fetchSubmitOrderEvents(body["id"] as number);
    expect(
      events.some(
        (event) => event.eventType === "REJECTED" && event.reason === "ZERO_SIZE",
      ),
    ).toBe(true);
  });

  it("MARKET sobre instrumento sin marketdata (PGR) ⇒ 201 REJECTED NO_PRICE + evento", async () => {
    const userId = await freshUserWithCash("10000.00");
    const res = await postOrder(userId, {
      instrumentId: PGR_ID,
      side: "BUY",
      type: "MARKET",
      size: 10,
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("NO_PRICE");

    const events = await fetchSubmitOrderEvents(body["id"] as number);
    expect(
      events.some(
        (event) => event.eventType === "REJECTED" && event.reason === "NO_PRICE",
      ),
    ).toBe(true);
  });

  it("LIMIT GTC sobre PGR ⇒ 201 NEW igual (resting no exige precio)", async () => {
    const userId = await freshUserWithCash("10000.00");
    const res = await postOrder(userId, {
      instrumentId: PGR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 1,
      price: "100",
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("NEW");
    expect(body["reason"]).toBeNull();
  });

  it("SELL sin posición vendible ⇒ 201 REJECTED INSUFFICIENT_POSITION + evento", async () => {
    const userId = await freshUserWithCash("10000.00"); // cash pero SIN posición
    const res = await postOrder(userId, {
      instrumentId: SEED_INSTRUMENT_BMA_ID,
      side: "SELL",
      type: "MARKET",
      size: 1,
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("REJECTED");
    expect(body["reason"]).toBe("INSUFFICIENT_POSITION");

    const events = await fetchSubmitOrderEvents(body["id"] as number);
    expect(
      events.some(
        (event) =>
          event.eventType === "REJECTED" &&
          event.reason === "INSUFFICIENT_POSITION",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Errores del borde (400/404) — SIN orden persistida
// ---------------------------------------------------------------------------

describe("UC-3 submit · errores del borde", () => {
  it("size Y amountArs juntos ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await postOrder(SEED_USER_EMILIANO_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
      amountArs: "1000",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: unknown } }).error?.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("LIMIT sin price ⇒ 400", async () => {
    const res = await postOrder(SEED_USER_EMILIANO_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 5,
    });
    expect(res.status).toBe(400);
  });

  it("MARKET con price ⇒ 400", async () => {
    const res = await postOrder(SEED_USER_EMILIANO_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
      price: "900",
    });
    expect(res.status).toBe(400);
  });

  it("amountArs como NÚMERO JSON ⇒ 400 (D3: el number no se acepta ni chico)", async () => {
    // El number sale por el wire tal cual: el cast documenta que lo que se
    // ejercita es el rechazo del CONTRATO (Zod), no del tipado del test.
    const numberMoneyPayload = {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      amountArs: 1000, // number JSON: el contrato exige string canónico
    } as unknown as Record<string, unknown>;
    const res = await postOrder(SEED_USER_EMILIANO_ID, numberMoneyPayload);
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: unknown } }).error?.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("instrumento MONEDA (ARS) ⇒ 400 INSTRUMENT_NOT_OPERABLE sin orden", async () => {
    const res = await postOrder(SEED_USER_EMILIANO_ID, {
      instrumentId: SEED_INSTRUMENT_ARS_ID,
      side: "BUY",
      type: "MARKET",
      size: 10,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: unknown } }).error?.code).toBe(
      "INSTRUMENT_NOT_OPERABLE",
    );
  });

  it("por ticker MONEDA ⇒ 400 también", async () => {
    const res = await postOrder(SEED_USER_EMILIANO_ID, {
      ticker: "ARS",
      side: "BUY",
      type: "MARKET",
      size: 10,
    });
    expect(res.status).toBe(400);
  });

  it("ticker inexistente ⇒ 404 INSTRUMENT_NOT_FOUND", async () => {
    const res = await postOrder(SEED_USER_EMILIANO_ID, {
      ticker: "NOPE",
      side: "BUY",
      type: "MARKET",
      size: 1,
    });
    expect(res.status).toBe(404);
    expect((res.body as { error?: { code?: unknown } }).error?.code).toBe(
      "INSTRUMENT_NOT_FOUND",
    );
  });

  it("usuario inexistente ⇒ 404 USER_NOT_FOUND", async () => {
    const res = await postOrder(99999, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
    });
    expect(res.status).toBe(404);
    expect((res.body as { error?: { code?: unknown } }).error?.code).toBe(
      "USER_NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrencia (lock por usuario + claim) — variante GTC
// ---------------------------------------------------------------------------
// La variante MARKET (una FILLED + una REJECTED) es la matriz D caso 13 y
// requiere el fix de mapSettledMovementRow (QUESTION): el segundo submit
// valida fondos contra los movimientos del usuario, y tras un fill creado
// por la API esa lectura rompe en el mapper de B. La variante GTC ejerce EL
// MISMO lock + la misma validación dentro de la tx (reserva en vez de
// débito) sin crear filas FILLED ⇒ pasa hoy y sigue pasando tras el fix.

describe("UC-3 submit · concurrencia sobre el cash", () => {
  it("dos GTC BUY simultáneas que JUNTAS exceden el disponible ⇒ una NEW, una REJECTED", async () => {
    const userId = await freshUserWithCash("700000.00");
    const payload = {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 500, // 500 × 930 = 465.000; dos juntas exceden 700.000
      price: "930",
    };
    const before = await getPortfolio(userId);

    const settled = await Promise.allSettled([
      postOrder(userId, payload),
      postOrder(userId, payload),
    ]);

    const bodies = settled.map((result) => {
      expect(result.status).toBe("fulfilled");
      return (result as PromiseFulfilledResult<Response>).value.body as Record<
        string,
        unknown
      >;
    });

    // El lock serializa: una reserva, la otra ve el cash ya reservado.
    const statuses = bodies.map((body) => body["status"]).sort();
    expect(statuses).toEqual(["NEW", "REJECTED"]);
    expect(bodies[0]?.["id"]).not.toBe(bodies[1]?.["id"]); // dos órdenes distintas

    const rejected = bodies.find((body) => body["status"] === "REJECTED");
    expect(rejected?.["reason"]).toBe("INSUFFICIENT_FUNDS");

    const orderId = rejected?.["id"];
    expect(typeof orderId).toBe("number");
    const events = await fetchSubmitOrderEvents(orderId as number);
    expect(
      events.some(
        (event) =>
          event.eventType === "REJECTED" &&
          event.reason === "INSUFFICIENT_FUNDS",
      ),
    ).toBe(true);

    // Un solo efecto: una sola reserva de 500 × 930.
    const after = await getPortfolio(userId);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(500, "930.00")}`),
    );
    expectMoneyArs(
      after.reservedCash,
      expectedCashAfter(before.reservedCash, costArs(500, "930.00")),
    );
  });
});