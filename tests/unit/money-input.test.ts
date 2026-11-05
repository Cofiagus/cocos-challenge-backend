// T2a — entrada monetaria: string decimal canónico, contrato firmado (D3 de
// specs/datos-financieros-grandes-montos.md).
//
// El borde YA NO acepta números JSON, ni siquiera pequeños: el parser de JSON
// perdió cifras antes de que el contrato las vea. La gramática es base 10
// (`^-?(0|[1-9]\d*)(\.\d{1,2})?$`): sin exponente, espacios, `+`, separador de
// miles ni ceros iniciales; el máximo (NUMERIC(24,2)) se valida UNA sola vez
// desde MAX_STORED_ARSS. `ArsWireSchema`/`PositiveArsWireSchema` validan la
// forma para OpenAPI sin transformar; los `*InputSchema` transforman a
// `FinancialDecimal` para dominio.

import { Decimal } from "decimal.js";
import {
  ArsInputSchema,
  ArsWireSchema,
  MAX_STORED_ARSS,
  PositiveArsInputSchema,
  PositiveArsWireSchema,
} from "../../src/contracts/money.js";
import { FinancialDecimal } from "../../src/contracts/financial-decimal.js";

const MAX_ARSS = "9999999999999999999999.99";

describe("gramática del wire — strings canónicos", () => {
  it("acepta enteros y hasta 2 decimales, incluido el máximo D1", () => {
    for (const value of [
      "123.45",
      "0.01",
      "0.5",
      "1500",
      MAX_ARSS,
      "1.00",
    ]) {
      expect(ArsWireSchema.safeParse(value).success).toBe(true);
      expect(PositiveArsWireSchema.safeParse(value).success).toBe(true);
    }
    // "0" es válido en el wire firmado, pero no para el positivo.
    expect(ArsWireSchema.safeParse("0").success).toBe(true);
    expect(PositiveArsWireSchema.safeParse("0").success).toBe(false);
  });

  it("acepta negativos en el schema firmado; el positivo los rechaza", () => {
    expect(ArsWireSchema.safeParse("-123.45").success).toBe(true);
    expect(ArsWireSchema.safeParse(`-${MAX_ARSS}`).success).toBe(true);
    expect(PositiveArsWireSchema.safeParse("-123.45").success).toBe(false);
    expect(PositiveArsWireSchema.safeParse("-0.01").success).toBe(false);
  });

  it("rechaza números JSON aunque sean pequeños (cero, entero, decimal, 1e-2)", () => {
    for (const value of [123.45, 0, -1, 1500, 1e-2, 0.07]) {
      expect(ArsWireSchema.safeParse(value).success).toBe(false);
      expect(ArsInputSchema.safeParse(value).success).toBe(false);
      expect(PositiveArsInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza exponente, espacios, signo +, separador de miles y formas no canónicas", () => {
    for (const value of [
      "1e3",
      "1E3",
      "1.5e-3",
      " 1.00",
      "1.00 ",
      "\t1.00",
      "+1.00",
      "1,00",
      "1_000.00",
      ".5",
      "1.",
      "00.5",
      "01.00",
      "-00.5",
      "",
      "abc",
      "123.45.67",
    ]) {
      expect(ArsWireSchema.safeParse(value).success).toBe(false);
      expect(ArsInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza >2 decimales: el mensaje dice qué se espera (2 decimales)", () => {
    expect(() => ArsInputSchema.parse("100.005")).toThrow(/2 decimales/);
    expect(() => ArsInputSchema.parse("0.001")).toThrow(/2 decimales/);
    expect(() => PositiveArsInputSchema.parse("123.456")).toThrow(/2 decimales/);
  });

  it("rechaza no-finitos escritos como string (NaN/Infinity)", () => {
    for (const value of ["NaN", "Infinity", "-Infinity"]) {
      expect(ArsWireSchema.safeParse(value).success).toBe(false);
      expect(ArsInputSchema.safeParse(value).success).toBe(false);
      expect(PositiveArsInputSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("cota NUMERIC(24,2) — una sola definición", () => {
  it("MAX_STORED_ARSS es el máximo D1 con sus centavos", () => {
    expect(MAX_STORED_ARSS).toBeInstanceOf(Decimal);
    expect(MAX_STORED_ARSS.toFixed(2)).toBe(MAX_ARSS);
    expect(MAX_STORED_ARSS.toFixed(2)).toHaveLength(25);
  });

  it("acepta el máximo exacto (ambos signos) y rechaza máximo + 0.01", () => {
    expect(ArsInputSchema.safeParse(MAX_ARSS).success).toBe(true);
    expect(PositiveArsInputSchema.safeParse(MAX_ARSS).success).toBe(true);
    expect(ArsInputSchema.safeParse(`-${MAX_ARSS}`).success).toBe(true);

    expect(() => ArsInputSchema.parse("10000000000000000000000.00")).toThrow(
      /9999999999999999999999\.99/,
    );
    expect(() => PositiveArsInputSchema.parse("10000000000000000000000.00")).toThrow(
      /9999999999999999999999\.99/,
    );
    expect(ArsInputSchema.safeParse(`-10000000000000000000000.00`).success).toBe(false);
    expect(ArsInputSchema.safeParse("99999999999999999999999.99").success).toBe(false);
  });

  it("el mismo máximo acota el schema wire, sin una segunda constante", () => {
    expect(ArsWireSchema.safeParse("10000000000000000000000.00").success).toBe(false);
    expect(PositiveArsWireSchema.safeParse("10000000000000000000000.00").success).toBe(
      false,
    );
  });
});

describe("transform a FinancialDecimal", () => {
  it("devuelve una instancia del constructor financiero con el valor exacto", () => {
    const parsed = ArsInputSchema.parse(MAX_ARSS);
    expect(parsed).toBeInstanceOf(FinancialDecimal);
    expect(parsed).toBeInstanceOf(Decimal);
    expect(parsed.toFixed(2)).toBe(MAX_ARSS);
    expect(PositiveArsInputSchema.parse("0.01").toFixed(2)).toBe("0.01");
    expect(ArsInputSchema.parse("-123.45").toFixed(2)).toBe("-123.45");
  });

  it("no pasa por number: un string con 22 enteros conserva todas las cifras", () => {
    // `toString` usa notación exponencial desde 1e21; `toFixed` es el formato del contrato.
    expect(ArsInputSchema.parse(MAX_ARSS).toFixed(2)).toBe(MAX_ARSS);
    expect(ArsInputSchema.parse("90071992547409.93").toFixed(2)).toBe("90071992547409.93");
  });
});

describe("positividad del input", () => {
  it("sigue rechazando cero y negativos (la cota no relaja la positividad)", () => {
    for (const value of ["0", "0.00", "-0.01", "-123.45"]) {
      expect(PositiveArsInputSchema.safeParse(value).success).toBe(false);
    }
    expect(() => PositiveArsInputSchema.parse("0")).toThrow(/mayor que 0/);
  });

  it("ArsInput sí acepta cero y negativos dentro de la cota", () => {
    for (const value of ["0", "0.00", "-0.01", "-123.45"]) {
      expect(ArsInputSchema.safeParse(value).success).toBe(true);
    }
  });
});
