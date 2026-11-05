// Contrato de UC-2 (GET /api/instruments) — spec instruments-current-quotes
// Rev. 2: query ausente, vacía o sólo espacios ⇒ listado inicial ("" tras
// trim); con texto ⇒ match parcial case-insensitive (lo resuelve el repo);
// limit default 10, entero 1..100; strictObject: campo desconocido ⇒ error.
//
// Dinero de salida (D3 / money.ts): price y previousClose viajan como STRING
// monetario de exactamente 2 decimales (MoneyArs), nunca number; el número
// JSON se rechaza. dailyVariationPct sigue siendo number (Pct).
// Sin DB, sin red, sin Express: sólo el schema del borde.

import {
  DEFAULT_INSTRUMENT_SEARCH_LIMIT,
  InstrumentSearchQuerySchema,
  InstrumentSearchResultSchema,
  MAX_INSTRUMENT_SEARCH_LIMIT,
} from "../../src/contracts/instruments.js";

/** Paths de los issues de Zod (vacío si el input es válido). */
const rejectionPaths = (input: unknown): readonly string[] => {
  const result = InstrumentSearchQuerySchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
};

describe("InstrumentSearchQuerySchema — query opcional = listado inicial", () => {
  it("expone el default de la spec Rev. 2 (10) y la cota 100", () => {
    expect(DEFAULT_INSTRUMENT_SEARCH_LIMIT).toBe(10);
    expect(MAX_INSTRUMENT_SEARCH_LIMIT).toBe(100);
  });

  it("query ausente ⇒ válido con query '' (listado inicial, no 400)", () => {
    const result = InstrumentSearchQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success ? result.data.query : undefined).toBe("");
  });

  it("query vacía ⇒ válida con query ''", () => {
    const result = InstrumentSearchQuerySchema.safeParse({ query: "" });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.query : undefined).toBe("");
  });

  it("query sólo espacios ⇒ válida y normalizada a '' (listado inicial)", () => {
    for (const whitespace of ["   ", "\t", " \n\t "]) {
      const result = InstrumentSearchQuerySchema.safeParse({
        query: whitespace,
      });
      expect(result.success).toBe(true);
      expect(result.success ? result.data.query : undefined).toBe("");
    }
  });

  it("query con texto se conserva (recortada) para el match parcial", () => {
    const result = InstrumentSearchQuerySchema.safeParse({ query: "  pamp  " });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.query : undefined).toBe("pamp");
  });

  it("query no string ⇒ rechazada", () => {
    for (const bad of [123, null, true, ["PAMP"]]) {
      expect(rejectionPaths({ query: bad })).toContain("query");
    }
  });
});

describe("InstrumentSearchQuerySchema — limit default 10 y rango 1..100", () => {
  it("limit ausente ⇒ default 10", () => {
    const result = InstrumentSearchQuerySchema.safeParse({ query: "PAMP" });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.limit : undefined).toBe(10);
  });

  it("acepta los bordes 1 y 100 (y el string del cable se coercita)", () => {
    for (const limit of [1, 100, "1", "100"]) {
      const result = InstrumentSearchQuerySchema.safeParse({ limit });
      expect(result.success).toBe(true);
      expect(result.success ? result.data.limit : undefined).toBe(
        Number(limit),
      );
    }
  });

  it("rechaza 0, 101, negativos, decimales y no numéricos", () => {
    for (const bad of [0, 101, -5, 2.5, "abc", "", null]) {
      expect(rejectionPaths({ limit: bad })).toContain("limit");
    }
  });
});

describe("InstrumentSearchQuerySchema — borde estricto", () => {
  it("rechaza campos desconocidos (strictObject, nunca confiar en req.query)", () => {
    expect(
      InstrumentSearchQuerySchema.safeParse({ query: "PAMP", offset: "2" })
        .success,
    ).toBe(false);
    expect(InstrumentSearchQuerySchema.safeParse({ foo: "1" }).success).toBe(
      false,
    );
  });
});

describe("InstrumentSearchResultSchema — sólo incluye cotizaciones válidas", () => {
  // D3: precio y cierre previo son strings monetarios de 2 decimales.
  const result = {
    ticker: "PAMP",
    name: "Pampa Holding S.A.",
    type: "ACCIONES",
    price: "123.45",
    previousClose: "120.00",
    dailyVariationPct: 2.88,
  } as const;

  it("acepta resultado con cotización y variación presentes", () => {
    expect(InstrumentSearchResultSchema.safeParse(result).success).toBe(true);
  });

  it("rechaza null: el caso de uso omite instrumentos sin cotización", () => {
    expect(
      InstrumentSearchResultSchema.safeParse({ ...result, price: null })
        .success,
    ).toBe(false);
    expect(
      InstrumentSearchResultSchema.safeParse({ ...result, previousClose: null })
        .success,
    ).toBe(false);
    expect(
      InstrumentSearchResultSchema.safeParse({
        ...result,
        dailyVariationPct: null,
      }).success,
    ).toBe(false);
  });

  it("rechaza el number JSON en price/previousClose (perdió cifras antes del contrato)", () => {
    expect(
      InstrumentSearchResultSchema.safeParse({ ...result, price: 123.45 })
        .success,
    ).toBe(false);
    expect(
      InstrumentSearchResultSchema.safeParse({ ...result, previousClose: 120 })
        .success,
    ).toBe(false);
  });

  it("exige exactamente 2 decimales en el string monetario", () => {
    expect(
      InstrumentSearchResultSchema.safeParse({ ...result, price: "123.4" })
        .success,
    ).toBe(false);
    expect(
      InstrumentSearchResultSchema.safeParse({ ...result, previousClose: "120" })
        .success,
    ).toBe(false);
  });
});
