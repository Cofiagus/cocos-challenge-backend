// T1 — constructor Decimal financiero: precisión 64 aislada, sin mutar el
// Decimal global. D1 de specs/datos-financieros-grandes-montos.md.
//
// Presupuesto: precio máximo (22 enteros + 2 decimales) × acciones por orden
// (INT4) ≈ 43 cifras. Precisión 20 (la default de decimal.js) pierde cifras en
// esos productos; estos tests fijan la exactitud y prueban que el default NO
// cambió para el resto del código.

import { Decimal } from "decimal.js";
import { FinancialDecimal } from "../../src/contracts/financial-decimal.js";

const MAX_ARSS = "9999999999999999999999.99";

describe("FinancialDecimal — configuración aislada", () => {
  it("tiene precisión 64 y ROUND_HALF_UP", () => {
    expect(FinancialDecimal.precision).toBe(64);
    expect(FinancialDecimal.rounding).toBe(Decimal.ROUND_HALF_UP);
  });

  it("NO muta el Decimal global: sigue en precisión 20 y sin half-up forzado", () => {
    expect(Decimal.precision).toBe(20);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP); // default de decimal.js
    // 1/3 con 20 cifras significativas: el default no se amplió por importar el contrato.
    expect(new Decimal(1).div(3).toString()).toBe("0.33333333333333333333");
    // El constructor financiero sí calcula con 64.
    expect(new FinancialDecimal(1).div(3).toString()).toBe(
      `0.${"3".repeat(64)}`,
    );
  });

  it("produce instancias de Decimal (interoperables, sin clase paralela)", () => {
    expect(new FinancialDecimal("1.23")).toBeInstanceOf(Decimal);
  });

  it("redondea HALF_UP, no HALF_EVEN, en el constructor financiero", () => {
    expect(new FinancialDecimal("0.005").toDecimalPlaces(2).toFixed(2)).toBe("0.01");
    expect(new FinancialDecimal("2.5").toDecimalPlaces(0).toFixed(0)).toBe("3");
    expect(new FinancialDecimal("-2.5").toDecimalPlaces(0).toFixed(0)).toBe("-3");
  });
});

describe("FinancialDecimal — aritmética de grandes montos", () => {
  it("conserva el máximo D1 con sus centavos (string → string, sin number)", () => {
    expect(new FinancialDecimal(MAX_ARSS).toFixed(2)).toBe(MAX_ARSS);
  });

  it("restar un centavo al máximo da exactamente ...99.98", () => {
    expect(
      new FinancialDecimal(MAX_ARSS).minus("0.01").toFixed(2),
    ).toBe("9999999999999999999999.98");
    // Y volver a sumarlo reconstruye el máximo sin residuo.
    expect(
      new FinancialDecimal(MAX_ARSS).minus("0.01").plus("0.01").toFixed(2),
    ).toBe(MAX_ARSS);
  });

  it("producto precio máximo × INT4 máximo es exacto (43 cifras)", () => {
    // 9999999999999999999999.99 × 2147483647 = ...(exacto, verificado fuera de JS)
    expect(
      new FinancialDecimal(MAX_ARSS).times(2147483647).toFixed(2),
    ).toBe("21474836469999999999999978525163.53");
    // Un producto con parte decimal no binaria también queda exacto.
    expect(new FinancialDecimal(MAX_ARSS).times("1.99").toFixed(2)).toBe(
      "19899999999999999999999.98",
    );
  });

  it("suma agregada de 1000 máximos supera la precisión 20 sin perder cifras", () => {
    let total = new FinancialDecimal(0);
    for (let index = 0; index < 1000; index += 1) {
      total = total.plus(MAX_ARSS);
    }
    expect(total.toFixed(2)).toBe("9999999999999999999999990.00");
  });

  it("cancela exactamente: sumar y restar el mismo monto no deja residuo", () => {
    const base = new FinancialDecimal("90071992547409.93");
    const total = base
      .plus("9999999999999999999999.99")
      .plus("1234567890123456789012.34")
      .minus("9999999999999999999999.99")
      .minus("1234567890123456789012.34");
    expect(total.toFixed(2)).toBe("90071992547409.93");
    // La cancelación es exacta: el residuo es cero, no un epsilon de float.
    expect(total.minus(base).isZero()).toBe(true);
  });

  it("acumula centavos sin error: 10000 × 0.01 = 100.00", () => {
    let total = new FinancialDecimal(0);
    for (let index = 0; index < 10_000; index += 1) {
      total = total.plus("0.01");
    }
    expect(total.toFixed(2)).toBe("100.00");
  });

  it("restar un centavo a 90071992547409.93 no toca los centavos del resultado", () => {
    expect(new FinancialDecimal("90071992547409.93").minus("0.01").toFixed(2)).toBe(
      "90071992547409.92",
    );
    // El camino por number SÍ pierde el centavo: por eso el contrato prohíbe numbers.
    expect(new FinancialDecimal(Number("90071992547409.93")).toFixed(2)).toBe(
      "90071992547409.94",
    );
  });
});
