// Unit (SIN DB, T11.b): la comparación de identidad del request es una
// función PURA sobre un tipo de fila estructural propio, así que los casos
// legacy se ejercitan con filas CONSTRUIDAS A MANO. Antes había que insertar
// filas no conformes (LIMIT sin price, cash con precio/instrumento cambiados)
// para llegar al CONFLICT: esa era la deuda que impedía los CHECKs en la DB.
//
// Semántica cubierta: huella en ambos lados ⇒ manda la huella; huella NULL en
// cualquiera ⇒ comparación histórica (identidad + `size`); todo cambio de
// identidad es CONFLICT conservador.

import {
  classifyTradingRequest,
  sameIdentityPayload,
  sameTradingRequest,
  type OrderRequestRow,
  type RequestPayload,
} from "../../../src/infra/prisma/request-comparison.js";

/** Fila de trading tal como quedó escrita: LIMIT BUY NEW GTC 10 @ 930.00. */
const tradingRow = (overrides: Partial<OrderRequestRow> = {}): OrderRequestRow => ({
  instrumentId: 47,
  side: "BUY",
  type: "LIMIT",
  timeInForce: "GTC",
  price: "930.00",
  size: "10.00",
  requestFingerprint: null,
  ...overrides,
});

/** Request equivalente al de la fila (mismo payload, misma key implícita). */
const tradingPayload = (overrides: Partial<RequestPayload> = {}): RequestPayload => ({
  instrumentId: 47,
  side: "BUY",
  type: "LIMIT",
  timeInForce: "GTC",
  price: "930.00",
  size: "10",
  requestFingerprint: null,
  ...overrides,
});

/** Fila cash histórica: CASH_IN MARKET FILLED, monto 123, precio unitario 1.00. */
const cashRow = (overrides: Partial<OrderRequestRow> = {}): OrderRequestRow => ({
  instrumentId: 66,
  side: "CASH_IN",
  type: "MARKET",
  timeInForce: "GTC",
  price: "1.00",
  size: "123.00",
  requestFingerprint: null,
  ...overrides,
});

/** Request cash equivalente (monto exacto 123.00). */
const cashPayload = (overrides: Partial<RequestPayload> = {}): RequestPayload => ({
  instrumentId: 66,
  side: "CASH_IN",
  type: "MARKET",
  timeInForce: "GTC",
  price: "1.00",
  size: "123.00",
  requestFingerprint: null,
  ...overrides,
});

describe("request-comparison — identidad del payload (sin DB)", () => {
  it("payload idéntico (Decimal por valor: '10' == '10.00') ⇒ misma identidad", () => {
    expect(sameIdentityPayload(tradingRow(), tradingPayload())).toBe(true);
    expect(sameIdentityPayload(cashRow(), cashPayload())).toBe(true);
  });

  it.each([
    ["instrumento", { instrumentId: 31 }],
    ["side", { side: "SELL" }],
    ["tipo", { type: "MARKET" }],
    ["timeInForce", { timeInForce: "IOC" }],
    ["precio", { price: "999.00" }],
  ] as const)("cambio de %s ⇒ NO es la misma identidad", (_label, overrides) => {
    expect(sameIdentityPayload(tradingRow(), tradingPayload(overrides))).toBe(false);
  });
});

describe("request-comparison — huella del request (F2-IDEM)", () => {
  it("huellas iguales ⇒ REPLAY aunque el size derivado no coincida (manda el request)", () => {
    const row = tradingRow({ requestFingerprint: "fp-original", size: "4.00" });
    const payload = tradingPayload({ requestFingerprint: "fp-original", size: "5" });
    expect(classifyTradingRequest(row, payload)).toBe("IDEMPOTENT_REPLAY");
  });

  it("huellas distintas (mismo floor, monto original distinto) ⇒ CONFLICT", () => {
    const row = tradingRow({ requestFingerprint: "fp-de-1000.00", size: "4.00" });
    const payload = tradingPayload({ requestFingerprint: "fp-de-1000.50", size: "4" });
    expect(classifyTradingRequest(row, payload)).toBe("IDEMPOTENT_CONFLICT");
  });

  it("huella solo en la fila y size distinto ⇒ CONFLICT por el fallback histórico", () => {
    const row = tradingRow({ requestFingerprint: "fp-original", size: "10.00" });
    const payload = tradingPayload({ requestFingerprint: null, size: "25" });
    expect(classifyTradingRequest(row, payload)).toBe("IDEMPOTENT_CONFLICT");
  });

  it("fila sin huella + payload idéntico ⇒ REPLAY (comportamiento vigente intacto)", () => {
    expect(classifyTradingRequest(tradingRow(), tradingPayload())).toBe(
      "IDEMPOTENT_REPLAY",
    );
  });

  it("fila sin huella + payload que difiere en el size ⇒ CONFLICT conservador", () => {
    expect(
      sameTradingRequest(tradingRow(), tradingPayload({ size: "25" })),
    ).toBe(false);
    expect(classifyTradingRequest(tradingRow(), tradingPayload({ size: "25" }))).toBe(
      "IDEMPOTENT_CONFLICT",
    );
  });
});

describe("request-comparison — caminos legacy que se probaban insertando filas", () => {
  it("LIMIT con price NULL en la fila y precio en el request ⇒ CONFLICT", () => {
    const row = tradingRow({ price: null });
    expect(classifyTradingRequest(row, tradingPayload())).toBe("IDEMPOTENT_CONFLICT");
  });

  it("LIMIT con price NULL en ambos lados y mismo size ⇒ REPLAY", () => {
    const row = tradingRow({ price: null });
    const payload = tradingPayload({ price: null });
    expect(classifyTradingRequest(row, payload)).toBe("IDEMPOTENT_REPLAY");
  });

  it("LIMIT con price en la fila y NULL en el request ⇒ CONFLICT", () => {
    expect(
      classifyTradingRequest(tradingRow(), tradingPayload({ price: null })),
    ).toBe("IDEMPOTENT_CONFLICT");
  });

  it("fila sin size (columna legacy) ⇒ CONFLICT, nunca REPLAY optimista", () => {
    expect(classifyTradingRequest(tradingRow({ size: null }), tradingPayload())).toBe(
      "IDEMPOTENT_CONFLICT",
    );
  });

  it("cash con el precio unitario cambiado (2.00) ⇒ CONFLICT aunque el monto coincida", () => {
    expect(sameIdentityPayload(cashRow(), cashPayload({ price: "2.00" }))).toBe(false);
  });

  it("cash con el instrumento cambiado ⇒ CONFLICT aunque el monto coincida", () => {
    expect(sameIdentityPayload(cashRow(), cashPayload({ instrumentId: 47 }))).toBe(
      false,
    );
  });

  it("cash con el side cambiado (CASH_OUT) ⇒ CONFLICT", () => {
    expect(sameIdentityPayload(cashRow(), cashPayload({ side: "CASH_OUT" }))).toBe(
      false,
    );
  });

  it("cash con el monto cambiado: la identidad no cambia y el size decide ⇒ CONFLICT", () => {
    // El monto cash NO integra la identidad (vive en `size`): con huella en
    // ambos lados manda la huella (REPLAY si es igual); sin huella, el size
    // decide (CONFLICT si el monto cambió).
    const row = cashRow();
    const changedAmount = cashPayload({ size: "123.99" });
    expect(sameIdentityPayload(row, changedAmount)).toBe(true);
    expect(sameTradingRequest(row, changedAmount)).toBe(false);
  });
});
