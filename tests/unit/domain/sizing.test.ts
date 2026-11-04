// Tests unitarios de sizeSharesFromAmountArs (FASE 2 — Célula A):
// floor(amount/price) exacto con Decimal, incluida la trampa clásica del
// float (0.30/0.10). La decisión de ZERO_SIZE es de la capa de aplicación.

import { Decimal } from "decimal.js";
import { sizeSharesFromAmountArs } from "../../../src/domain/sizing/index.js";
import { SEED_REFERENCE_CLOSES } from "../../helpers/fixtures.js";

/** Residuo derivable: amount − size × price (lo calcula el llamador). */
const residualArs = (amountArs: Decimal, priceArs: Decimal, size: number): Decimal =>
  amountArs.minus(new Decimal(String(size)).mul(priceArs));

describe("sizeSharesFromAmountArs — size = floor(amount / precio)", () => {
  it("1000 / 925.85 → 1 acción, residuo exacto 74.15 (no redondea a 1.08)", () => {
    const amountArs = new Decimal("1000.00");
    const priceArs = new Decimal(SEED_REFERENCE_CLOSES.PAMP); // 925.85

    const size = sizeSharesFromAmountArs(amountArs, priceArs);

    expect(size).toBe(1);
    expect(residualArs(amountArs, priceArs, size).toFixed(2)).toBe("74.15");
  });

  it("múltiplo exacto: 1851.70 / 925.85 → 2 acciones, residuo 0.00", () => {
    const amountArs = new Decimal("1851.70");
    const priceArs = new Decimal(SEED_REFERENCE_CLOSES.PAMP);

    const size = sizeSharesFromAmountArs(amountArs, priceArs);

    expect(size).toBe(2);
    expect(residualArs(amountArs, priceArs, size).toFixed(2)).toBe("0.00");
  });

  it("múltiplo exacto NO cae por error de redondeo: 2777.55 / 925.85 → 3", () => {
    // 925.85 × 3 = 2777.55 exacto: el floor debe dar 3, no 2 por un
    // 2.9999… intermedio (lo que pasaría con float).
    expect(
      sizeSharesFromAmountArs(new Decimal("2777.55"), new Decimal("925.85")),
    ).toBe(3);
  });

  it("trampa del float: 0.30 / 0.10 → 3 exacto (en float daría 2.999…→2)", () => {
    expect(sizeSharesFromAmountArs(new Decimal("0.30"), new Decimal("0.10"))).toBe(3);
  });

  it("monto menor al precio → size 0 (el REJECTED ZERO_SIZE lo decide la aplicación)", () => {
    const size = sizeSharesFromAmountArs(new Decimal("500.00"), new Decimal("925.85"));
    expect(size).toBe(0);
    // El residuo derivable sigue siendo consistente: 500 − 0×925.85 = 500.
    expect(residualArs(new Decimal("500.00"), new Decimal("925.85"), size).toFixed(2)).toBe("500.00");
  });

  it("floor nunca pasa el múltiplo: 1851.69 / 925.85 → 1 (un centavo menos, una acción menos)", () => {
    const amountArs = new Decimal("1851.69");
    const priceArs = new Decimal(SEED_REFERENCE_CLOSES.PAMP);

    const size = sizeSharesFromAmountArs(amountArs, priceArs);

    expect(size).toBe(1); // 1.99999… → floor 1, nunca se vende más de lo pedido
    expect(residualArs(amountArs, priceArs, size).toFixed(2)).toBe("925.84");
  });
});