// FIX 1 (análisis PR #2, FASE 1 — contratos): el dinero de ENTRADA debe caber
// en el dominio de almacenamiento numeric(10,2). Tests unitarios SIN DB que
// pellizcan el borde: el rechazo llega como 400 del contrato, no como
// redondeo silencioso de Postgres (>2 decimales) ni como 500 del INSERT (≥ 8
// dígitos). Ver cota en src/contracts/money.ts.

import {
  ArsInputSchema,
  PositiveArsInputSchema,
} from "../../src/contracts/money.js";

describe("PositiveArsInputSchema — cota del dominio numeric(10,2)", () => {
  it("acepta dentro de la cota: 123.45, borde 99999999.99, number y string", () => {
    for (const value of [123.45, "123.45", 99999999.99, "99999999.99", 1500, "1500"]) {
      expect(PositiveArsInputSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rechaza >2 decimales: el mensaje dice qué se espera (2 decimales)", () => {
    expect(() => PositiveArsInputSchema.parse(100.005)).toThrow(/2 decimales/);
    expect(() => PositiveArsInputSchema.parse("100.005")).toThrow(/2 decimales/);
    expect(() => PositiveArsInputSchema.parse("0.001")).toThrow(/2 decimales/);
    expect(() => PositiveArsInputSchema.parse(123.456)).toThrow(/2 decimales/);
  });

  it("rechaza ≥ 100000000: excede numeric(10,2) y explotaría en el INSERT (500, no 400)", () => {
    expect(() => PositiveArsInputSchema.parse(100000000)).toThrow(/99999999\.99/);
    expect(() => PositiveArsInputSchema.parse("100000000")).toThrow(/99999999\.99/);
    expect(() => PositiveArsInputSchema.parse("100000000.99")).toThrow(/99999999\.99/);
  });

  it("rechaza no-finitos que Decimal parsea del string (NaN/Infinity)", () => {
    for (const value of ["NaN", "Infinity", "-Infinity"]) {
      expect(ArsInputSchema.safeParse(value).success).toBe(false);
      expect(PositiveArsInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it("sigue rechazando ≤ 0 (la cota no relaja la positividad)", () => {
    for (const value of [0, -1, "-123.45"]) {
      expect(PositiveArsInputSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("ArsInputSchema — la misma cota de numeric(10,2)", () => {
  it("acepta 0 y negativos dentro de la cota (la positividad es del Positive)", () => {
    for (const value of [0, "0", -123.45]) {
      expect(ArsInputSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rechaza fuera de la cota también en negativo (numeric(10,2) es ±)", () => {
    expect(() => ArsInputSchema.parse(-100.005)).toThrow(/2 decimales/);
    expect(() => ArsInputSchema.parse(-100000000)).toThrow(/99999999\.99/);
  });
});