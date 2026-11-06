// Huella canónica del REQUEST (F2-IDEM, R1) — tests SIN DB y sin Express.
//
// Lo que fija esta suite: la huella se calcula con el body YA validado, sobre
// el monto ORIGINAL (`amountArs`) cuando el request vino por monto — nunca
// sobre el `size` derivado por floor — con el instrumento RESUELTO (el ticker
// no participa) y con el dinero normalizado a 2 decimales ("123.0" ≡
// "123.00"). Dos pedidos que el floor colapsa en el mismo `size` tienen
// huellas DISTINTAS: eso es lo que convierte el REPLAY espurio en 409.

import { CreateOrderRequestSchema } from "../../src/contracts/index.js";
import { requestFingerprintOf } from "../../src/contracts/index.js";

/** Body de un request tal como llega al borde (wire, ya validado por Zod). */
const requestOf = (body: unknown) => CreateOrderRequestSchema.parse(body);

const PAMP_ID = 7;

/** Request LIMIT BUY por MONTO: el caso del defecto (amountArs → floor). */
const amountRequest = (amountArs: string, overrides: Record<string, unknown> = {}) =>
  requestOf({
    instrumentId: PAMP_ID,
    side: "BUY",
    type: "LIMIT",
    amountArs,
    price: "250.00",
    ...overrides,
  });

describe("requestFingerprintOf — forma canónica", () => {
  it("es estable y tiene forma `fp1:<32 hex>` (corta, no secreta ni PII)", () => {
    const fingerprint = requestFingerprintOf(amountRequest("1000.00"), PAMP_ID);

    expect(fingerprint).toMatch(/^fp1:[0-9a-f]{32}$/);
    // Mismo request ⇒ misma huella (sin reloj, sin azar, sin DB).
    expect(requestFingerprintOf(amountRequest("1000.00"), PAMP_ID)).toBe(fingerprint);
  });

  it("'1000.0' y '1000.00' son el MISMO monto ⇒ MISMA huella", () => {
    expect(requestFingerprintOf(amountRequest("1000.0"), PAMP_ID)).toBe(
      requestFingerprintOf(amountRequest("1000.00"), PAMP_ID),
    );
  });

  it("'1000.00' vs '1000.50' (mismo floor ⇒ mismo size) ⇒ huellas DISTINTAS", () => {
    // floor(1000.00 / 250.00) = floor(1000.50 / 250.00) = 4 acciones: el
    // `size` derivado no los distingue, la huella sí.
    expect(requestFingerprintOf(amountRequest("1000.50"), PAMP_ID)).not.toBe(
      requestFingerprintOf(amountRequest("1000.00"), PAMP_ID),
    );
  });

  it("el precio también se normaliza: '250.0' ≡ '250.00'", () => {
    const body = {
      instrumentId: PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      amountArs: "1000.00",
    };
    expect(requestFingerprintOf(requestOf({ ...body, price: "250.0" }), PAMP_ID)).toBe(
      requestFingerprintOf(requestOf({ ...body, price: "250.00" }), PAMP_ID),
    );
    expect(requestFingerprintOf(requestOf({ ...body, price: "251.00" }), PAMP_ID)).not.toBe(
      requestFingerprintOf(requestOf({ ...body, price: "250.00" }), PAMP_ID),
    );
  });

  it("ticker e instrumentId del MISMO instrumento resuelto ⇒ MISMA huella", () => {
    const byId = requestOf({
      instrumentId: PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      amountArs: "1000.00",
      price: "250.00",
    });
    const byTicker = requestOf({
      ticker: "PAMP",
      side: "BUY",
      type: "LIMIT",
      amountArs: "1000.00",
      price: "250.00",
    });

    // El borde ya resolvió el ticker: la huella usa el id, nunca el ticker.
    expect(requestFingerprintOf(byTicker, PAMP_ID)).toBe(
      requestFingerprintOf(byId, PAMP_ID),
    );
  });

  it("mismo `size` derivado pero distinto pedido (size explícito vs amountArs) ⇒ DISTINTAS", () => {
    const byAmount = amountRequest("1000.00");
    const bySize = requestOf({
      instrumentId: PAMP_ID,
      side: "BUY",
      type: "LIMIT",
      size: 4,
      price: "250.00",
    });

    expect(requestFingerprintOf(bySize, PAMP_ID)).not.toBe(
      requestFingerprintOf(byAmount, PAMP_ID),
    );
  });

  it("cada campo del payload canónico cambia la huella (side, type, timeInForce, monto)", () => {
    const base = requestFingerprintOf(amountRequest("1000.00"), PAMP_ID);
    const variants = [
      amountRequest("1000.00", { side: "SELL" }),
      amountRequest("1000.00", { type: "MARKET", price: null }),
      amountRequest("1000.00", { timeInForce: "IOC" }),
      amountRequest("1001.00"),
    ];
    for (const variant of variants) {
      expect(requestFingerprintOf(variant, PAMP_ID)).not.toBe(base);
    }
  });

  it("otro instrumento ⇒ otra huella (el id resuelto es parte del payload)", () => {
    const request = amountRequest("1000.00");
    expect(requestFingerprintOf(request, PAMP_ID)).not.toBe(
      requestFingerprintOf(request, PAMP_ID + 1),
    );
  });

  it("MARKET sin price: price ausente y price null son la MISMA huella", () => {
    const body = {
      instrumentId: PAMP_ID,
      side: "BUY",
      type: "MARKET",
      amountArs: "1000.00",
    };
    expect(requestFingerprintOf(requestOf(body), PAMP_ID)).toBe(
      requestFingerprintOf(requestOf({ ...body, price: null }), PAMP_ID),
    );
  });
});
