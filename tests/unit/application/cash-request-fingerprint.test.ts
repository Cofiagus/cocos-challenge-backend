// Huella del pedido de CASH (R-02) — tests SIN DB y sin Express.
//
// Lo que fija esta suite: el monto EXACTO de una transferencia viaja en la
// huella del request (no sólo en `metadata.amountArs` del evento de auditoría),
// normalizado a 2 decimales ("123.0" ≡ "123.00"). Dos montos distintos tienen
// huellas distintas, así el claim detecta el conflicto aunque el `size`
// histórico (floor) coincida y aunque la auditoría no sea legible.
//
// La huella de cash usa un namespace propio (`fpc1`) para que NUNCA pueda
// compararse contra la de trading (`fp1`) de la misma orden.

import { FinancialDecimal } from "../../../src/contracts/index.js";
import { cashRequestFingerprintOf } from "../../../src/contracts/index.js";

const ARS_ID = 66;

/** Pedido de cash tal como lo arma submitTransfer (CASH_IN a 1.00). */
const cashRequest = (amountArs: string, overrides: Record<string, unknown> = {}) => ({
  instrumentId: ARS_ID,
  side: "CASH_IN" as const,
  type: "MARKET",
  timeInForce: "GTC",
  priceArs: new FinancialDecimal("1.00"),
  amountArs: new FinancialDecimal(amountArs),
  ...overrides,
});

describe("cashRequestFingerprintOf — forma canónica", () => {
  it("es estable y tiene forma `fpc1:<32 hex>`", () => {
    const fingerprint = cashRequestFingerprintOf(cashRequest("123.45"));

    expect(fingerprint).toMatch(/^fpc1:[0-9a-f]{32}$/);
    expect(cashRequestFingerprintOf(cashRequest("123.45"))).toBe(fingerprint);
  });

  it("'123.0' y '123.00' son el MISMO monto ⇒ MISMA huella", () => {
    expect(cashRequestFingerprintOf(cashRequest("123.0"))).toBe(
      cashRequestFingerprintOf(cashRequest("123.00")),
    );
  });

  it("montos distintos ⇒ huellas DISTINTAS (el monto exacto es el discriminante)", () => {
    expect(cashRequestFingerprintOf(cashRequest("123.45"))).not.toBe(
      cashRequestFingerprintOf(cashRequest("123.99")),
    );
    // Mismo floor (123) y mismo size histórico: la huella los distingue igual.
    expect(cashRequestFingerprintOf(cashRequest("123.45"))).not.toBe(
      cashRequestFingerprintOf(cashRequest("123.90")),
    );
  });

  it("cada campo del pedido cambia la huella (side, instrumento, precio, monto)", () => {
    const base = cashRequestFingerprintOf(cashRequest("123.45"));
    const variants = [
      cashRequest("123.45", { side: "CASH_OUT" }),
      cashRequest("123.45", { instrumentId: ARS_ID + 1 }),
      cashRequest("123.45", { priceArs: new FinancialDecimal("2.00") }),
      cashRequest("123.45", { priceArs: null }),
      cashRequest("123.46"),
    ];
    for (const variant of variants) {
      expect(cashRequestFingerprintOf(variant)).not.toBe(base);
    }
  });

  it("la huella de cash y la de trading viven en namespaces distintos", () => {
    // Aunque el payload fuera el mismo dinero, `fpc1` ≠ `fp1`: una huella de
    // cash jamás se compara contra una de trading (y viceversa).
    expect(cashRequestFingerprintOf(cashRequest("123.45")).startsWith("fpc1:")).toBe(
      true,
    );
  });
});
