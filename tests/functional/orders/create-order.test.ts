// Célula D — tests funcionales UC-3 (POST /api/users/:userId/orders), suite
// ROJA de FASE 2.
//
// Corre contra `serverApp` (stub del orquestador: sin routers → 404 hoy) y
// contra la DB AISLADA `cocos_challenge_ftest` (recreada en beforeAll desde
// la migración + db/seed.sql — golden values verificados por el orquestador,
// ver tests/helpers/fixtures.ts). Los esperados salen de las DECISIONES ya
// firmadas y del contrato (src/contracts): nada de esto se discute acá,
// se testea.
//
// Matriz completa del orquestador, un describe por caso (1..13). TODO test
// arranca con el assert del status del POST: hoy el stub responde 404 y el
// fallo esperado de la suite es exactamente ése (o los asserts de valores),
// nunca un error de setup.

import { API_ERROR_CODES } from "../../../src/contracts/index.js";
import {
  SEED_INSTRUMENTS_WITHOUT_MARKETDATA,
  SEED_INSTRUMENT_ARS_ID,
  SEED_INSTRUMENT_BMA_ID,
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
  SEED_REFERENCE_CLOSES,
  SEED_USER_EMILIANO_ID,
} from "../../helpers/fixtures.js";
import {
  asErrorBody,
  asOrderBody,
  costArs,
  expectedCashAfter,
  expectMoneyArs,
  getPortfolio,
  postOrder,
  type OrderPayload,
} from "./client.js";
import {
  closeFunctionalDbPool,
  countOrdersForUser,
  countOrdersWithIdempotencyKey,
  fetchOrderEvents,
  fetchOrderRow,
  resetFunctionalDatabase,
} from "./db.js";

// El reset (drop/create + migrate deploy + seed) es lento; los tests en sí
// no (DB local + supertest in-memory).
jest.setTimeout(30_000);

const USER_ID = SEED_USER_EMILIANO_ID;
/** Closes de referencia del seed (última fecha de marketdata por date). */
const REF = SEED_REFERENCE_CLOSES;
/** PGR — instrumento SIN marketdata en el seed (⇒ precio de referencia null). */
const SEED_INSTRUMENT_PGR_ID = SEED_INSTRUMENTS_WITHOUT_MARKETDATA[0];

beforeAll(async () => {
  // DB de la célula D al estado del seed: la suite es autocontenida e
  // idempotente entre corridas de `npm test`.
  await resetFunctionalDatabase();
}, 240_000);

afterAll(async () => {
  await closeFunctionalDbPool();
});

// ---------------------------------------------------------------------------
// 1 · MARKET BUY con fondos
// ---------------------------------------------------------------------------

describe("UC-3 · 1 · MARKET BUY con fondos", () => {
  it("201 FILLED al precio de referencia EXACTO y cash disponible baja size × ref", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("FILLED");
    expect(body.side).toBe("BUY");
    expect(body.size).toBe(5);
    expect(body.timeInForce).toBe("GTC"); // default del contrato
    expect(body.price).toBeNull(); // MARKET no lleva límite
    expect(body.reason).toBeNull();
    expect(typeof body.filledAt).toBe("string"); // FILLED en la misma transacción
    expect(typeof body.datetime).toBe("string");
    expectMoneyArs(body.filledPrice, REF.PAMP); // 925.85 exacto — el de referencia

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("FILLED");
    expect(row?.size).toBe("5.00"); // NUMERIC(24,2): pg lo devuelve como string
    expect(row?.price).toBeNull();
    expect(row?.filledPrice).toBe("925.85");

    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(5, REF.PAMP)}`), // −4629.25
    );
  });
});

// ---------------------------------------------------------------------------
// 2 · MARKET BUY sin fondos
// ---------------------------------------------------------------------------

describe("UC-3 · 2 · MARKET BUY sin fondos", () => {
  it("201 REJECTED persistida con razón INSUFFICIENT_FUNDS (response Y order_events), sin efecto en cash", async () => {
    const before = await getPortfolio(USER_ID);
    // 1000 × 925.85 = 925.850 > cash disponible del seed (627.500).
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 1000,
    });

    expect(res.status).toBe(201); // éxito 201 TAMBIÉN para REJECTED persistida
    const body = asOrderBody(res);
    expect(body.status).toBe("REJECTED");
    expect(body.reason).toBe("INSUFFICIENT_FUNDS");
    expect(body.filledPrice).toBeNull();
    expect(body.filledAt).toBeNull();

    // Persistida con su razón.
    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("REJECTED");
    expect(row?.side).toBe("BUY");

    const events = await fetchOrderEvents(body.id);
    expect(
      events.some(
        (event) =>
          event.eventType === "REJECTED" &&
          event.reason === "INSUFFICIENT_FUNDS",
      ),
    ).toBe(true);

    // Sin reserva ni débito: el cash disponible no se mueve.
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "0.00"));
  });
});

// ---------------------------------------------------------------------------
// 3 · MARKET SELL sin acciones
// ---------------------------------------------------------------------------

describe("UC-3 · 3 · MARKET SELL sin acciones vendibles", () => {
  it("201 REJECTED persistida con razón INSUFFICIENT_POSITION (posición BMA del seed: −10, vendibles 0)", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_BMA_ID,
      side: "SELL",
      type: "MARKET",
      size: 10,
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("REJECTED");
    expect(body.reason).toBe("INSUFFICIENT_POSITION");
    expect(body.filledPrice).toBeNull();

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("REJECTED");
    expect(row?.side).toBe("SELL");

    const events = await fetchOrderEvents(body.id);
    expect(
      events.some(
        (event) =>
          event.eventType === "REJECTED" &&
          event.reason === "INSUFFICIENT_POSITION",
      ),
    ).toBe(true);

    const after = await getPortfolio(USER_ID);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "0.00"));
  });
});

// ---------------------------------------------------------------------------
// 4 · MARKET por amountArs
// ---------------------------------------------------------------------------

describe("UC-3 · 4 · MARKET BUY por amountArs", () => {
  it("size = floor(amountArs / ref) EXACTO y el residuo queda como cash (baja size × ref, NO amountArs)", async () => {
    const before = await getPortfolio(USER_ID);
    // floor(1000 / 229.50) = 4 → ejecuta 4 × 229.50 = 918.00; residúan 82.00 en cash.
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "MARKET",
      amountArs: "1000",
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("FILLED");
    expect(body.size).toBe(4); // floor exacto
    expectMoneyArs(body.filledPrice, REF.METR);

    const row = await fetchOrderRow(body.id);
    expect(row?.size).toBe("4.00");
    expect(row?.filledPrice).toBe("229.50");

    const after = await getPortfolio(USER_ID);
    // Baja 918.00 (size × ref), NO 1000 (el residuo no se debita).
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(4, REF.METR)}`),
    );
  });

  it("amountArs menor que un precio ⇒ size 0 ⇒ 201 REJECTED ZERO_SIZE persistida", async () => {
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_BMA_ID,
      side: "BUY",
      type: "MARKET",
      amountArs: "100", // floor(100 / 1502.80) = 0
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("REJECTED");
    expect(body.reason).toBe("ZERO_SIZE");
    expect(body.size).toBe(0); // contrato: size 0 (no null) en REJECTED por ZERO_SIZE

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("REJECTED");
    expect(row?.size).toBe("0.00");

    const events = await fetchOrderEvents(body.id);
    expect(
      events.some(
        (event) => event.eventType === "REJECTED" && event.reason === "ZERO_SIZE",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5 · LIMIT GTC queda NEW y reserva cash
// ---------------------------------------------------------------------------

describe("UC-3 · 5 · LIMIT GTC ⇒ NEW y reserva fondos", () => {
  it("201 NEW y el cash disponible del portfolio baja limit × size (GET antes/después)", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 10,
      price: "250", // sin timeInForce → default GTC del contrato
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("NEW"); // LIMIT GTC siempre NEW (nunca se llena al enviar)
    expect(body.timeInForce).toBe("GTC");
    expect(body.size).toBe(10);
    expectMoneyArs(body.price, "250.00"); // price = límite enviado
    expect(body.filledPrice).toBeNull(); // sin ejecución
    expect(body.reason).toBeNull();

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("NEW");
    expect(row?.timeInForce).toBe("GTC");
    expect(row?.price).toBe("250.00");
    expect(row?.filledPrice).toBeNull();

    // Reserva: el disponible baja 10 × 250 = 2500 y el reservado sube 2500.
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(10, "250.00")}`),
    );
    expectMoneyArs(
      after.reservedCash,
      expectedCashAfter(before.reservedCash, costArs(10, "250.00")),
    );
  });
});

// ---------------------------------------------------------------------------
// 6 · LIMIT IOC / FOK evaluados una vez contra el precio de referencia
// ---------------------------------------------------------------------------

describe("UC-3 · 6 · LIMIT IOC / FOK", () => {
  it("IOC que cruza (BUY con límite ARRIBA del ref) ⇒ FILLED con filledPrice MEJORADO al ref", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: "950", // ref 925.85 → cruza → ejecuta a min(950, ref)
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("FILLED");
    expect(body.timeInForce).toBe("IOC");
    expectMoneyArs(body.price, "950.00"); // el límite enviado queda en orders.price
    expectMoneyArs(body.filledPrice, REF.PAMP); // mejora: al ref, no al límite

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("FILLED");
    expect(row?.price).toBe("950.00");
    expect(row?.filledPrice).toBe("925.85");

    // Debita 2 × 925.85 (el precio de ejecución), no 2 × 950.
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(2, REF.PAMP)}`),
    );
  });

  it("IOC que NO cruza ⇒ 201 CANCELLED con razón NO_IMMEDIATE_MATCH, sin fills ni reserva", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: "900", // ref 925.85 → no cruza
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("CANCELLED");
    expect(body.reason).toBe("NO_IMMEDIATE_MATCH");
    expect(body.filledPrice).toBeNull();
    expect(body.filledAt).toBeNull();

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("CANCELLED");

    const events = await fetchOrderEvents(body.id);
    expect(
      events.some(
        (event) =>
          event.eventType === "CANCELLED" &&
          event.reason === "NO_IMMEDIATE_MATCH",
      ),
    ).toBe(true);

    const after = await getPortfolio(USER_ID);
    expectMoneyArs(after.cash, expectedCashAfter(before.cash, "0.00"));
  });

  it("FOK que cruza ⇒ FILLED con filledPrice mejorado al ref", async () => {
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "FOK",
      size: 2,
      price: "950", // ref 925.85 → cruza
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("FILLED");
    expect(body.timeInForce).toBe("FOK");
    expectMoneyArs(body.filledPrice, REF.PAMP);
  });

  it("FOK que NO cruza ⇒ 201 CANCELLED NO_IMMEDIATE_MATCH", async () => {
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "FOK",
      size: 2,
      price: "900", // ref 925.85 → no cruza
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("CANCELLED");
    expect(body.reason).toBe("NO_IMMEDIATE_MATCH");
  });

  it("SELL que cruza (límite ABAJO del ref) ⇒ FILLED a max(límite, ref) = ref", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_METR_ID, // posición 500, sin reservas SELL
      side: "SELL",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 5,
      price: "200", // ref 229.50 → cruza → ejecuta a max(200, ref)
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("FILLED");
    expectMoneyArs(body.filledPrice, REF.METR); // mejora para el vendedor: al ref

    // Los proceeds suman al cash: 5 × 229.50.
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, costArs(5, REF.METR)),
    );
  });
});

// ---------------------------------------------------------------------------
// 7 · Instrumento sin marketdata (PGR)
// ---------------------------------------------------------------------------

describe("UC-3 · 7 · Instrumento sin precio (PGR, sin marketdata en el seed)", () => {
  it("MARKET ⇒ 201 REJECTED NO_PRICE persistida, con la razón en order_events", async () => {
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PGR_ID,
      side: "BUY",
      type: "MARKET",
      size: 10,
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("REJECTED");
    expect(body.reason).toBe("NO_PRICE");

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("REJECTED");

    const events = await fetchOrderEvents(body.id);
    expect(
      events.some(
        (event) => event.eventType === "REJECTED" && event.reason === "NO_PRICE",
      ),
    ).toBe(true);
  });

  it("IOC y FOK también ⇒ 201 REJECTED NO_PRICE (necesitan el ref para evaluarse)", async () => {
    for (const timeInForce of ["IOC", "FOK"] as const) {
      const res = await postOrder(USER_ID, {
        instrumentId: SEED_INSTRUMENT_PGR_ID,
        side: "BUY",
        type: "LIMIT",
        timeInForce,
        size: 10,
        price: "100",
      });

      expect(res.status).toBe(201);
      const body = asOrderBody(res);
      expect(body.status).toBe("REJECTED");
      expect(body.reason).toBe("NO_PRICE");
    }
  });

  it("LIMIT GTC ⇒ 201 NEW (resting no exige precio) y reserva fondos igual", async () => {
    const before = await getPortfolio(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PGR_ID,
      side: "BUY",
      type: "LIMIT",
      size: 10,
      price: "100",
    });

    expect(res.status).toBe(201);
    const body = asOrderBody(res);
    expect(body.status).toBe("NEW");
    expect(body.reason).toBeNull();

    const row = await fetchOrderRow(body.id);
    expect(row?.status).toBe("NEW");

    // Reserva limit × size aunque no haya precio de referencia.
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(10, "100.00")}`),
    );
  });
});

// ---------------------------------------------------------------------------
// 8 · Instrumento MONEDA (ARS)
// ---------------------------------------------------------------------------

describe("UC-3 · 8 · Instrumento MONEDA (ARS)", () => {
  it("por instrumentId ⇒ 400 con body de error del contrato y SIN orden persistida", async () => {
    const before = await countOrdersForUser(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_ARS_ID,
      side: "BUY",
      type: "MARKET",
      size: 10,
    });

    expect(res.status).toBe(400);
    const errorBody = asErrorBody(res);
    expect(errorBody.error?.code).toBe(API_ERROR_CODES.INSTRUMENT_NOT_OPERABLE);
    expect(typeof errorBody.error?.message).toBe("string");

    expect(await countOrdersForUser(USER_ID)).toBe(before);
  });

  it("por ticker ⇒ 400 también", async () => {
    const res = await postOrder(USER_ID, {
      ticker: "ARS",
      side: "BUY",
      type: "MARKET",
      size: 10,
    });

    expect(res.status).toBe(400);
    expect(asErrorBody(res).error?.code).toBe(
      API_ERROR_CODES.INSTRUMENT_NOT_OPERABLE,
    );
  });
});

// ---------------------------------------------------------------------------
// 9 · Payload inválido ⇒ 400 SIN crear orden
// ---------------------------------------------------------------------------

describe("UC-3 · 9 · Payload inválido", () => {
  it("size Y amountArs juntos ⇒ 400 sin registro en orders", async () => {
    const before = await countOrdersForUser(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
      amountArs: "1000",
    });

    expect(res.status).toBe(400);
    expect(asErrorBody(res).error?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(await countOrdersForUser(USER_ID)).toBe(before);
  });

  it("LIMIT sin price ⇒ 400 sin registro en orders", async () => {
    const before = await countOrdersForUser(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 5,
    });

    expect(res.status).toBe(400);
    expect(asErrorBody(res).error?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(await countOrdersForUser(USER_ID)).toBe(before);
  });

  it("size ≤ 0 ⇒ 400 sin registro en orders", async () => {
    const before = await countOrdersForUser(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 0,
    });

    expect(res.status).toBe(400);
    expect(await countOrdersForUser(USER_ID)).toBe(before);
  });

  it("amountArs como NÚMERO JSON ⇒ 400 sin registro en orders (D3: el number no se acepta ni chico)", async () => {
    const before = await countOrdersForUser(USER_ID);
    // El number sale por el wire tal cual: el cast documenta que lo que se
    // ejercita es el rechazo del CONTRATO (Zod), no del tipado del test.
    const numberMoneyPayload = {
      instrumentId: SEED_INSTRUMENT_METR_ID,
      side: "BUY",
      type: "MARKET",
      amountArs: 1000, // number JSON: el contrato exige string canónico
    } as unknown as OrderPayload;
    const res = await postOrder(USER_ID, numberMoneyPayload);

    expect(res.status).toBe(400);
    expect(asErrorBody(res).error?.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
    expect(await countOrdersForUser(USER_ID)).toBe(before);
  });

  it("MARKET con price ⇒ 400 sin registro en orders", async () => {
    const before = await countOrdersForUser(USER_ID);
    const res = await postOrder(USER_ID, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
      price: "900",
    });

    expect(res.status).toBe(400);
    expect(await countOrdersForUser(USER_ID)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 10 · Usuario inexistente
// ---------------------------------------------------------------------------

describe("UC-3 · 10 · Usuario inexistente", () => {
  it("404 con body de error y sin orden persistida", async () => {
    const res = await postOrder(99999, {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 5,
    });

    expect(res.status).toBe(404);
    const errorBody = asErrorBody(res);
    expect(errorBody.error?.code).toBe(API_ERROR_CODES.USER_NOT_FOUND);
    expect(typeof errorBody.error?.message).toBe("string");

    expect(await countOrdersForUser(99999)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11 · Idempotencia secuencial
// ---------------------------------------------------------------------------

describe("UC-3 · 11 · Idempotencia (Idempotency-Key)", () => {
  const key = "cell-d-idem-secuencial";
  const payload: OrderPayload = {
    instrumentId: SEED_INSTRUMENT_METR_ID,
    side: "BUY",
    type: "LIMIT",
    size: 5,
    price: "210",
  };

  it("misma key + mismo payload ⇒ devuelve la MISMA orden, sin duplicar ni reservar dos veces", async () => {
    const before = await getPortfolio(USER_ID);
    const firstRes = await postOrder(USER_ID, payload, key);
    expect(firstRes.status).toBe(201);
    const first = asOrderBody(firstRes);
    expect(first.status).toBe("NEW");

    const secondRes = await postOrder(USER_ID, payload, key);
    expect(secondRes.status).toBe(201);
    const second = asOrderBody(secondRes);
    expect(second.id).toBe(first.id); // misma orden, mismo id

    expect(await countOrdersWithIdempotencyKey(USER_ID, key)).toBe(1);

    const row = await fetchOrderRow(first.id);
    expect(row?.idempotencyKey).toBe(key);

    // Un solo efecto en cash (una sola reserva de 5 × 210).
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(5, "210.00")}`),
    );
  });

  it("misma key + payload DISTINTO ⇒ 409 con body de error, sin nueva orden", async () => {
    const before = await countOrdersWithIdempotencyKey(USER_ID, key);
    const res = await postOrder(
      USER_ID,
      { ...payload, size: 6 }, // misma key, otro payload
      key,
    );

    expect(res.status).toBe(409);
    const errorBody = asErrorBody(res);
    expect(errorBody.error?.code).toBe(API_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    expect(typeof errorBody.error?.message).toBe("string");

    expect(await countOrdersWithIdempotencyKey(USER_ID, key)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 11b · Huella del request: el monto ORIGINAL manda (F2-IDEM)
//
// El defecto: el claim comparaba el size derivado (floor(amountArs/precio)),
// así que dos pedidos con la misma key y montos del mismo floor devolvían
// REPLAY en vez del 409 del contrato. Acá se prueba el camino COMPLETO
// (router → submitOrder → draft con huella → claim), no sólo el repositorio.
// ---------------------------------------------------------------------------

describe("UC-3 · 11b · Huella del request (montos con la misma key)", () => {
  const byAmount = (amountArs: string): OrderPayload => ({
    instrumentId: SEED_INSTRUMENT_METR_ID,
    side: "BUY",
    type: "LIMIT",
    amountArs,
    price: "210.00", // floor(1000.00/210) = floor(1000.50/210) = 4 acciones
  });

  it("misma key + amountArs 1000.00 vs 1000.50 (MISMO floor) ⇒ 409, sin segunda orden", async () => {
    const key = "cell-d-idem-huella-monto";

    const first = await postOrder(USER_ID, byAmount("1000.00"), key);
    expect(first.status).toBe(201);

    const second = await postOrder(USER_ID, byAmount("1000.50"), key);
    expect(second.status).toBe(409);
    expect(asErrorBody(second).error?.code).toBe(
      API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
    );
    expect(await countOrdersWithIdempotencyKey(USER_ID, key)).toBe(1);
  });

  it("misma key + '1000.0' vs '1000.00' (mismo monto canónico) ⇒ 201 con la MISMA orden", async () => {
    const key = "cell-d-idem-huella-canonica";

    const first = await postOrder(USER_ID, byAmount("1000.0"), key);
    expect(first.status).toBe(201);

    const second = await postOrder(USER_ID, byAmount("1000.00"), key);
    expect(second.status).toBe(201);
    expect(asOrderBody(second).id).toBe(asOrderBody(first).id);
    expect(await countOrdersWithIdempotencyKey(USER_ID, key)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12 · Doble-submit concurrente con la misma key
// ---------------------------------------------------------------------------

describe("UC-3 · 12 · Doble-submit CONCURRENTE con la misma key", () => {
  it("dos POST en Promise.allSettled ⇒ EXACTAMENTE una orden creada y UN solo efecto en cash", async () => {
    const key = "cell-d-idem-concurrente";
    const payload: OrderPayload = {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 3, // 3 × 925.85 = 2777.55
    };
    const before = await getPortfolio(USER_ID);

    const settled = await Promise.allSettled([
      postOrder(USER_ID, payload, key),
      postOrder(USER_ID, payload, key),
    ]);
    expect(settled).toHaveLength(2);

    const responses: Awaited<ReturnType<typeof postOrder>>[] = [];
    for (const result of settled) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") {
        responses.push(result.value);
      }
    }
    expect(responses).toHaveLength(2);
    expect(responses.every((res) => res.status === 201)).toBe(true);

    // Misma key ⇒ misma orden: ambas respuestas devuelven el MISMO id.
    const [firstBody, secondBody] = responses.map((res) => asOrderBody(res));
    expect(firstBody?.status).toBe("FILLED");
    expect(secondBody?.id).toBe(firstBody?.id);

    // EXACTAMENTE una orden con esa key en la DB.
    expect(await countOrdersWithIdempotencyKey(USER_ID, key)).toBe(1);

    // Un solo efecto en cash: una sola ejecución de 3 × 925.85.
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(3, REF.PAMP)}`),
    );
  });
});

// ---------------------------------------------------------------------------
// 13 · Dos órdenes simultáneas que juntas exceden el cash disponible
// ---------------------------------------------------------------------------

describe("UC-3 · 13 · Concurrencia sobre el cash disponible", () => {
  it("dos MARKET BUY simultáneas que JUNTAS exceden el disponible ⇒ EXACTAMENTE una FILLED y una REJECTED", async () => {
    const payload: OrderPayload = {
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      side: "BUY",
      type: "MARKET",
      size: 500, // 500 × 925.85 = 462.925; dos juntas exceden el disponible
    };
    const before = await getPortfolio(USER_ID);
    const ordersBefore = await countOrdersForUser(USER_ID);

    const settled = await Promise.allSettled([
      postOrder(USER_ID, payload),
      postOrder(USER_ID, payload),
    ]);
    expect(settled).toHaveLength(2);

    const responses: Awaited<ReturnType<typeof postOrder>>[] = [];
    for (const result of settled) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") {
        expect(result.value.status).toBe(201);
        responses.push(result.value);
      }
    }

    const orderBodies = responses.map((res) => asOrderBody(res));
    const statuses = orderBodies.map((order) => order.status).sort();
    expect(statuses).toEqual(["FILLED", "REJECTED"]); // ni más, ni otro estado

    const filled = orderBodies.find((order) => order.status === "FILLED");
    const rejected = orderBodies.find((order) => order.status === "REJECTED");
    expectMoneyArs(filled?.filledPrice, REF.PAMP); // la FILLED, al ref
    expect(rejected?.reason).toBe("INSUFFICIENT_FUNDS");
    expect(orderBodies[0]?.id).not.toBe(orderBodies[1]?.id); // dos órdenes distintas

    // La REJECTED dejó su razón en order_events.
    const events = await fetchOrderEvents(rejected?.id ?? -1);
    expect(
      events.some(
        (event) =>
          event.eventType === "REJECTED" &&
          event.reason === "INSUFFICIENT_FUNDS",
      ),
    ).toBe(true);

    // Ambas persistidas: +2 filas para el usuario.
    expect(await countOrdersForUser(USER_ID)).toBe(ordersBefore + 2);

    // Un solo efecto en cash: sólo la FILLED (−462.925, no el doble).
    const after = await getPortfolio(USER_ID);
    expectMoneyArs(
      after.cash,
      expectedCashAfter(before.cash, `-${costArs(500, REF.PAMP)}`),
    );
  });
});