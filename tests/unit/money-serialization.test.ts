// T2b — salida monetaria: string con exactamente 2 decimales (D3 de
// specs/datos-financieros-grandes-montos.md). Distinto de la entrada de
// money-input.test.ts: acá se valida lo que la API EMITE.
//
// El valor sale del constructor financiero con `.toFixed(2)`; NUNCA pasa por
// number (el camino por number reproducía `90071992547409.94`). El schema de
// salida NO aplica el máximo de columna: un agregado (cash, patrimonio) puede
// superarlo y es válido. Porcentajes conservan su contrato numérico.

import {
  MoneyArsSchema,
  PctSchema,
  serializeMoneyArs,
  serializePct,
} from "../../src/contracts/money.js";
import { FinancialDecimal } from "../../src/contracts/financial-decimal.js";

describe("MoneyArsSchema — el string serializado de dinero", () => {
  it("acepta lo que la API emite: 2 decimales, enteros con .00 y negativos (BMA −10 del seed)", () => {
    for (const value of [
      "123.45",
      "0.07",
      "100.00",
      "0.00",
      "-50.00",
      "-15028.50",
      "90071992547409.93",
      "9999999999999999999999.99",
    ]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(true);
    }
  });

  it("acepta agregados MAYORES que el máximo de una fila (cash/patrimonio)", () => {
    // Σ de dos máximos: 23 enteros; el schema de salida no reutiliza la cota de columna.
    expect(MoneyArsSchema.safeParse("19999999999999999999999.98").success).toBe(true);
    expect(MoneyArsSchema.safeParse("-19999999999999999999999.98").success).toBe(true);
  });

  it("exige exactamente 2 decimales: rechaza 1.2, 1.234 y enteros sin punto", () => {
    for (const value of ["1.2", "1.234", "100", "0", "-0.001", "123.456"]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza -0.00 y exponentes (no son formas canónicas de salida)", () => {
    for (const value of ["-0.00", "1e3", "1E21", "9.99999999999999999999999e+21"]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza todo lo que no es string: números (antes el contrato), null, objetos, arrays, bool", () => {
    for (const value of [
      123.45,
      0,
      -50,
      NaN,
      Infinity,
      -Infinity,
      null,
      undefined,
      {},
      { a: 1 },
      [1],
      true,
    ]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza strings no numéricos o con adornos", () => {
    for (const value of ["abc", "123,45", " 123.45", "+123.45", "01.00", "NaN", "Infinity"]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("serializeMoneyArs — .toFixed(2) exacto desde el constructor financiero", () => {
  it("conserva el máximo D1 y el caso del centavo perdido 90071992547409.93", () => {
    expect(serializeMoneyArs(new FinancialDecimal("9999999999999999999999.99"))).toBe(
      "9999999999999999999999.99",
    );
    // Con Number, este valor se emitía como ...94.
    expect(serializeMoneyArs(new FinancialDecimal("90071992547409.93"))).toBe(
      "90071992547409.93",
    );
    expect(String(Number("90071992547409.93"))).toBe("90071992547409.94"); // el camino prohibido
  });

  it("emite el agregado de dos máximos sin redondear a la cota de columna", () => {
    const sum = new FinancialDecimal("9999999999999999999999.99").plus(
      "9999999999999999999999.99",
    );
    expect(serializeMoneyArs(sum)).toBe("19999999999999999999999.98");
  });

  it("devuelve string (nunca number) y siempre con 2 decimales", () => {
    const value = serializeMoneyArs(new FinancialDecimal("100"));
    expect(typeof value).toBe("string");
    expect(value).toBe("100.00");
    expect(serializeMoneyArs(new FinancialDecimal("-15028.5"))).toBe("-15028.50");
    expect(serializeMoneyArs(new FinancialDecimal("0.01"))).toBe("0.01");
  });

  it("normaliza el cero: 0, -0 y -0.001 salen como 0.00, jamás -0.00", () => {
    expect(serializeMoneyArs(new FinancialDecimal("0"))).toBe("0.00");
    expect(serializeMoneyArs(new FinancialDecimal("-0"))).toBe("0.00");
    expect(serializeMoneyArs(new FinancialDecimal("-0.001"))).toBe("0.00");
    expect(serializeMoneyArs(new FinancialDecimal("0.004"))).toBe("0.00");
    expect(MoneyArsSchema.safeParse(serializeMoneyArs(new FinancialDecimal("-0.001"))).success).toBe(
      true,
    );
  });

  it("cuantiza HALF_UP a 2 decimales (no trunca ni usa half-even)", () => {
    expect(serializeMoneyArs(new FinancialDecimal("1.005"))).toBe("1.01");
    expect(serializeMoneyArs(new FinancialDecimal("1.004"))).toBe("1.00");
    expect(serializeMoneyArs(new FinancialDecimal("2.675"))).toBe("2.68");
    expect(serializeMoneyArs(new FinancialDecimal("-1.005"))).toBe("-1.01");
  });

  it("rechaza no-finitos en vez de emitir 'Infinity'/'NaN'", () => {
    expect(() => serializeMoneyArs(new FinancialDecimal(Infinity))).toThrow(/finito/);
    expect(() => serializeMoneyArs(new FinancialDecimal(NaN))).toThrow(/finito/);
  });
});

describe("PctSchema — el número serializado de porcentaje (sin cambios de contrato)", () => {
  it("rechaza no-finitos: NaN, Infinity, -Infinity", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(PctSchema.safeParse(value).success).toBe(false);
    }
  });

  it("acepta lo que serializePct emite: enteros y 2 decimales", () => {
    for (const value of [1.23, -1.08, 0, 45, 100]) {
      expect(PctSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rechaza todo lo que no es number, igual que antes", () => {
    for (const value of ["abc", "1.23", null, undefined, {}, [1], true]) {
      expect(PctSchema.safeParse(value).success).toBe(false);
    }
  });

  it("ASIMETRÍA documentada: acepta >2 decimales (1.234); la cuantización la hace serializePct", () => {
    // PctSchema valida SOLO finitud: la garantía de 2 decimales de Pct vive en
    // serializePct (Decimal.toDecimalPlaces), no en el schema.
    expect(PctSchema.safeParse(1.234).success).toBe(true);
  });
});

describe("serializePct — sigue number, HALF_UP y finitud validada", () => {
  // Firma: `serializePct(pctX100: FinancialDecimal)`. El parámetro es el
  // constructor financiero del proyecto (64 cifras), no el `Decimal` global
  // (20). Ojo: las instancias de un `clone` de decimal.js son
  // ESTRUCTURALMENTE idénticas, así que TypeScript todavía acepta un
  // `Decimal` global; la restricción es de contrato/intención (y de revisión),
  // no de compilador. Hacerla nominal exige marcar el tipo en
  // `contracts/financial-decimal.ts` (fuera del alcance de esta celda).
  it("cuantiza a 2 decimales HALF_UP y devuelve number", () => {
    const value = serializePct(new FinancialDecimal("1.005"));
    expect(typeof value).toBe("number");
    expect(value).toBe(1.01);
    expect(serializePct(new FinancialDecimal("0.004"))).toBe(0);
    expect(serializePct(new FinancialDecimal("12.3"))).toBe(12.3);
    expect(serializePct(new FinancialDecimal("-1.08"))).toBe(-1.08);
  });

  it("rechaza no-finitos (no emite NaN/Infinity al contrato)", () => {
    expect(() => serializePct(new FinancialDecimal(Infinity))).toThrow(/finito/);
    expect(() => serializePct(new FinancialDecimal(NaN))).toThrow(/finito/);
  });

  it("rechaza un Decimal finito que desborda number (1e1000) en vez de emitir Infinity", () => {
    const huge = new FinancialDecimal("1e1000");
    expect(huge.isFinite()).toBe(true); // finito en Decimal...
    expect(Number(huge.toFixed(2))).toBe(Infinity); // ...pero no representable en number
    expect(() => serializePct(huge)).toThrow(RangeError);
    expect(() => serializePct(huge)).toThrow(/rango de number/);
  });
});
