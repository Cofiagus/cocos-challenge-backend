// Borde HTTP compartido — lectura del header Idempotency-Key y mapeo de la
// fila persistida al contrato (tests SIN DB).
//
// El header es OPCIONAL, su valor viaja al caso de uso TAL CUAL (no se
// recortan espacios) y Express entrega un header repetido como array.
//
// D3: `size` discrimina por side — number en trading, string monetario de 2
// decimales en cash — y los precios salen como string, nunca como number.

import { Decimal } from "decimal.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  type CashOrderRecord,
  type OrderRecord,
  type TradingOrderRecord,
} from "../../../src/contracts/index.js";
import {
  parseIdempotencyKeyHeader,
  toOrderResponse,
} from "../../../src/http/shared/edge.js";

describe("parseIdempotencyKeyHeader", () => {
  it("header ausente ⇒ key null (la key es opcional)", () => {
    expect(parseIdempotencyKeyHeader({})).toEqual({ ok: true, key: null });
  });

  it("header vacío ⇒ inválido (el contrato exige 1..64 caracteres)", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "" }),
    ).toEqual({ ok: false });
  });

  it("sólo espacios ⇒ válido y SIN recortar (no se normaliza el valor)", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "   " }),
    ).toEqual({ ok: true, key: "   " });
  });

  it("header repetido (array) ⇒ toma el primero", () => {
    expect(
      parseIdempotencyKeyHeader({
        [IDEMPOTENCY_KEY_HEADER]: ["primera", "segunda"],
      }),
    ).toEqual({ ok: true, key: "primera" });
  });

  it("array vacío ⇒ se comporta como header ausente", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: [] }),
    ).toEqual({ ok: true, key: null });
  });

  it("array cuyo primer valor es vacío ⇒ inválido", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: ["", "segunda"] }),
    ).toEqual({ ok: false });
  });

  it("key normal ⇒ se devuelve tal cual", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "orden-123" }),
    ).toEqual({ ok: true, key: "orden-123" });
  });

  it("64 caracteres ⇒ válida; 65 ⇒ inválida (cota del contrato)", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "a".repeat(64) }),
    ).toEqual({ ok: true, key: "a".repeat(64) });
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "a".repeat(65) }),
    ).toEqual({ ok: false });
  });
});

/** Fila persistida de TRADING mínima; cada caso cambia sólo lo que mira. */
const tradingOrder = (
  overrides: Partial<TradingOrderRecord> = {},
): OrderRecord => ({
  id: 7,
  instrumentId: 1,
  userId: 3,
  side: "BUY",
  type: "LIMIT",
  timeInForce: "GTC",
  status: "NEW",
  sizeShares: 10,
  priceArs: new Decimal("150.5"),
  filledPriceArs: null,
  filledAt: null,
  idempotencyKey: null,
  // Componentes LOCALES: el contrato serializa la hora local del mercado.
  datetime: new Date(2026, 0, 2, 3, 4, 5),
  ...overrides,
});

/** Fila persistida de CASH: su `size` físico es el monto en ARS. */
const cashOrder = (overrides: Partial<CashOrderRecord> = {}): OrderRecord => ({
  id: 8,
  instrumentId: 66,
  userId: 3,
  side: "CASH_IN",
  type: "MARKET",
  timeInForce: "GTC",
  status: "FILLED",
  amountArs: new Decimal("123"),
  priceArs: new Decimal("1.00"),
  filledPriceArs: new Decimal("1.00"),
  filledAt: new Date(2026, 0, 2, 3, 4, 5),
  idempotencyKey: null,
  datetime: new Date(2026, 0, 2, 3, 4, 5),
  ...overrides,
});

describe("toOrderResponse", () => {
  it("LIMIT NEW ⇒ price como string de 2 decimales, sin ejecución y reason null", () => {
    expect(toOrderResponse(tradingOrder(), null)).toEqual({
      id: 7,
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      status: "NEW",
      size: 10,
      price: "150.50",
      filledPrice: null,
      filledAt: null,
      datetime: "2026-01-02T03:04:05",
      reason: null,
    });
  });

  it("FILLED ⇒ filledPrice y filledAt serializados", () => {
    const response = toOrderResponse(
      tradingOrder({
        status: "FILLED",
        filledPriceArs: new Decimal("149.99"),
        filledAt: new Date(2026, 0, 2, 3, 4, 5),
      }),
      null,
    );
    expect(response.filledPrice).toBe("149.99");
    expect(response.filledAt).toBe("2026-01-02T03:04:05");
  });

  it("MARKET sin precio ⇒ price null (no se inventa un valor)", () => {
    const response = toOrderResponse(
      tradingOrder({ type: "MARKET", priceArs: null }),
      null,
    );
    expect(response.price).toBeNull();
  });

  it("REJECTED de trading ⇒ la razón viaja y size sigue number (0 en ZERO_SIZE)", () => {
    const response = toOrderResponse(
      tradingOrder({ status: "REJECTED", sizeShares: 0 }),
      "ZERO_SIZE",
    );
    expect(response.reason).toBe("ZERO_SIZE");
    expect(response.size).toBe(0);
  });

  it("CASH_IN histórico de size 123 ⇒ size \"123.00\" (string monetario, sin acciones)", () => {
    const response = toOrderResponse(cashOrder(), null);
    expect(response.side).toBe("CASH_IN");
    expect(response.size).toBe("123.00");
    expect(typeof response.size).toBe("string");
    expect(response.filledPrice).toBe("1.00");
    expect(response.price).toBe("1.00");
    expect(response.filledAt).toBe("2026-01-02T03:04:05");
  });

  it("CASH_OUT con centavos ⇒ size conserva los centavos exactos", () => {
    const response = toOrderResponse(
      cashOrder({
        side: "CASH_OUT",
        status: "REJECTED",
        amountArs: new Decimal("123.45"),
        filledPriceArs: null,
        filledAt: null,
      }),
      "INSUFFICIENT_FUNDS",
    );
    expect(response.size).toBe("123.45");
    expect(response.filledPrice).toBeNull();
    expect(response.filledAt).toBeNull();
    expect(response.reason).toBe("INSUFFICIENT_FUNDS");
  });
});
