// Schemas de SERIALIZACIÓN (Decimal → wire), distintos de los de entrada de
// money-input.test.ts: validan la forma del `number` JSON que emite la API.
// Un validador estricto del contrato (ajv contra openapi.json) debe aceptar
// exactamente lo que esta API emite — y sólo eso.

import { MoneyArsSchema, PctSchema } from "../../src/contracts/money.js";

describe("MoneyArsSchema — el número serializado de dinero", () => {
  it("acepta lo que la API emite: 2 decimales, enteros y negativos (BMA −10 del seed)", () => {
    for (const value of [123.45, 0.07, 100, 0, -50, -15028.5]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rechaza no-finitos: NaN, Infinity, -Infinity", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza >2 decimales: el refine de serialización no deja pasar 1.234", () => {
    for (const value of [1.234, -1.234, 100.005]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rechaza todo lo que no es number: strings, null, undefined, objetos, arrays, bool", () => {
    for (const value of ["abc", "123.45", "0.07", null, undefined, {}, { a: 1 }, [1], true]) {
      expect(MoneyArsSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("PctSchema — el número serializado de porcentaje", () => {
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

  it("rechaza todo lo que no es number, igual que MoneyArs", () => {
    for (const value of ["abc", "1.23", null, undefined, {}, [1], true]) {
      expect(PctSchema.safeParse(value).success).toBe(false);
    }
  });

  it("ASIMETRÍA documentada: acepta >2 decimales (1.234); la cuantización la hace serializePct", () => {
    // PctSchema valida SOLO finitud: la garantía de 2 decimales de Pct vive en
    // serializePct (Decimal.toDecimalPlaces), no en el schema — a diferencia de
    // MoneyArsSchema, que sí la valida. No cambiar el schema: estrecharlo acá
    // rompería la respuesta si serializePct cuantiza DESPUÉS del refine.
    expect(PctSchema.safeParse(1.234).success).toBe(true);
  });
});
