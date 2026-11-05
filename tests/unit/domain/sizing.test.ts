// Tests unitarios de sizeSharesFromAmountArs (T7 — dominio puro):
// floor(amount/price) exacto en el constructor financiero, incluida la
// trampa clásica del float (0.30/0.10). La decisión de ZERO_SIZE es de la
// capa de aplicación. El retorno SIGUE siendo number, pero el rango se
// valida EN Decimal ANTES de convertir: fuera de 0..MAX_ORDER_SIZE_SHARES
// lanza RangeError (el borde lo mapea a 400 sin INSERT).

import { FinancialDecimal, MAX_ORDER_SIZE_SHARES } from "../../../src/contracts/index.js";
import { sizeSharesFromAmountArs } from "../../../src/domain/sizing/index.js";
import { SEED_REFERENCE_CLOSES } from "../../helpers/fixtures.js";

/** Residuo derivable: amount − size × price (lo calcula el llamador). */
const residualArs = (
  amountArs: FinancialDecimal,
  priceArs: FinancialDecimal,
  size: number,
): FinancialDecimal =>
  amountArs.minus(new FinancialDecimal(String(size)).mul(priceArs));

describe("sizeSharesFromAmountArs — size = floor(amount / precio)", () => {
  it("1000 / 925.85 → 1 acción, residuo exacto 74.15 (no redondea a 1.08)", () => {
    const amountArs = new FinancialDecimal("1000.00");
    const priceArs = new FinancialDecimal(SEED_REFERENCE_CLOSES.PAMP); // 925.85

    const size = sizeSharesFromAmountArs(amountArs, priceArs);

    expect(size).toBe(1);
    expect(residualArs(amountArs, priceArs, size).toFixed(2)).toBe("74.15");
  });

  it("múltiplo exacto: 1851.70 / 925.85 → 2 acciones, residuo 0.00", () => {
    const amountArs = new FinancialDecimal("1851.70");
    const priceArs = new FinancialDecimal(SEED_REFERENCE_CLOSES.PAMP);

    const size = sizeSharesFromAmountArs(amountArs, priceArs);

    expect(size).toBe(2);
    expect(residualArs(amountArs, priceArs, size).toFixed(2)).toBe("0.00");
  });

  it("múltiplo exacto NO cae por error de redondeo: 2777.55 / 925.85 → 3", () => {
    // 925.85 × 3 = 2777.55 exacto: el floor debe dar 3, no 2 por un
    // 2.9999… intermedio (lo que pasaría con float).
    expect(
      sizeSharesFromAmountArs(
        new FinancialDecimal("2777.55"),
        new FinancialDecimal("925.85"),
      ),
    ).toBe(3);
  });

  it("trampa del float: 0.30 / 0.10 → 3 exacto (en float daría 2.999…→2)", () => {
    expect(
      sizeSharesFromAmountArs(
        new FinancialDecimal("0.30"),
        new FinancialDecimal("0.10"),
      ),
    ).toBe(3);
  });

  it("monto menor al precio → size 0 (el REJECTED ZERO_SIZE lo decide la aplicación)", () => {
    const size = sizeSharesFromAmountArs(
      new FinancialDecimal("500.00"),
      new FinancialDecimal("925.85"),
    );
    expect(size).toBe(0);
    // El residuo derivable sigue siendo consistente: 500 − 0×925.85 = 500.
    expect(
      residualArs(
        new FinancialDecimal("500.00"),
        new FinancialDecimal("925.85"),
        size,
      ).toFixed(2),
    ).toBe("500.00");
  });

  it("floor nunca pasa el múltiplo: 1851.69 / 925.85 → 1 (un centavo menos, una acción menos)", () => {
    const amountArs = new FinancialDecimal("1851.69");
    const priceArs = new FinancialDecimal(SEED_REFERENCE_CLOSES.PAMP);

    const size = sizeSharesFromAmountArs(amountArs, priceArs);

    expect(size).toBe(1); // 1.99999… → floor 1, nunca se vende más de lo pedido
    expect(residualArs(amountArs, priceArs, size).toFixed(2)).toBe("925.84");
  });

  it("centavos del precio no contaminan el floor: 92600.00 / 925.85 → 100", () => {
    // 925.85 × 100 = 92.585,00 exacto.
    expect(
      sizeSharesFromAmountArs(
        new FinancialDecimal("92585.00"),
        new FinancialDecimal("925.85"),
      ),
    ).toBe(100);
  });

  it("límite superior exacto: INT4 acciones cabe y sigue siendo number", () => {
    const size = sizeSharesFromAmountArs(
      new FinancialDecimal("214748364700.00"),
      new FinancialDecimal("100.00"),
    );
    expect(size).toBe(MAX_ORDER_SIZE_SHARES);
    expect(typeof size).toBe("number");
  });

  it("fuera de rango por UNA acción: lanza RangeError ANTES de toNumber", () => {
    // (INT4 + 1) × 100 = 214.748.364.800,00 → 2147483648 > MAX.
    expect(() =>
      sizeSharesFromAmountArs(
        new FinancialDecimal("214748364800.00"),
        new FinancialDecimal("100.00"),
      ),
    ).toThrow(RangeError);
  });

  it("monto máximo D1 con precio 1.00: 22 cifras → RangeError, nunca entero inseguro", () => {
    expect(() =>
      sizeSharesFromAmountArs(
        new FinancialDecimal("9999999999999999999999.99"),
        new FinancialDecimal("1.00"),
      ),
    ).toThrow(RangeError);
  });

  it("división no finita (precio 0) → RangeError en vez de devolver Infinity", () => {
    expect(() =>
      sizeSharesFromAmountArs(
        new FinancialDecimal("1000.00"),
        new FinancialDecimal("0"),
      ),
    ).toThrow(RangeError);
  });

  it("monto negativo → RangeError (el rango válido arranca en 0)", () => {
    expect(() =>
      sizeSharesFromAmountArs(
        new FinancialDecimal("-1000.00"),
        new FinancialDecimal("100.00"),
      ),
    ).toThrow(RangeError);
  });
});
