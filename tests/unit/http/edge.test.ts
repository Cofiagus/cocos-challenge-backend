// Borde HTTP compartido — lectura del header Idempotency-Key y mapeo de la
// fila persistida al contrato (tests SIN DB).
//
// El header es OPCIONAL, su valor viaja al caso de uso TAL CUAL (no se
// recortan espacios) y Express entrega un header repetido como array.

import { Decimal } from "decimal.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  type OrderRecord,
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

/** Fila persistida mínima; cada caso cambia sólo lo que mira. */
const orderRecord = (overrides: Partial<OrderRecord> = {}): OrderRecord => ({
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

describe("toOrderResponse", () => {
  it("LIMIT NEW ⇒ price serializado, sin ejecución y reason null", () => {
    expect(toOrderResponse(orderRecord(), null)).toEqual({
      id: 7,
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      status: "NEW",
      size: 10,
      price: 150.5,
      filledPrice: null,
      filledAt: null,
      datetime: "2026-01-02T03:04:05",
      reason: null,
    });
  });

  it("FILLED ⇒ filledPrice y filledAt serializados", () => {
    const response = toOrderResponse(
      orderRecord({
        status: "FILLED",
        filledPriceArs: new Decimal("149.99"),
        filledAt: new Date(2026, 0, 2, 3, 4, 5),
      }),
      null,
    );
    expect(response.filledPrice).toBe(149.99);
    expect(response.filledAt).toBe("2026-01-02T03:04:05");
  });

  it("MARKET sin precio ⇒ price null (no se inventa un valor)", () => {
    const response = toOrderResponse(
      orderRecord({ type: "MARKET", priceArs: null }),
      null,
    );
    expect(response.price).toBeNull();
  });

  it("REJECTED ⇒ la razón viaja tal cual en el body", () => {
    const response = toOrderResponse(
      orderRecord({ status: "REJECTED", sizeShares: 0 }),
      "INSUFFICIENT_FUNDS",
    );
    expect(response.reason).toBe("INSUFFICIENT_FUNDS");
    expect(response.size).toBe(0);
  });
});
