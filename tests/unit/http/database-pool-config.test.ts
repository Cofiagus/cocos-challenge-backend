// Pool por entorno (base REMOTA) — tests SIN DB.
//
// Los tres límites del pool tienen default histórico (10 / 5000 / 15000) y se
// pueden pisar con DATABASE_POOL_MAX, DATABASE_CONNECTION_TIMEOUT_MS y
// DATABASE_STATEMENT_TIMEOUT_MS. Sin esas variables la configuración es
// EXACTAMENTE la de siempre: local no cambia de comportamiento.
//
// Un valor definido pero inválido (vacío, 0, negativo, decimal, con espacios o
// fuera del rango entero seguro) FALLA con un mensaje accionable: caer al
// default en silencio dejaría la API corriendo con un pool que el operador no
// pidió. Vive en tests/unit/http/ porque es la suite que ejercita el borde de
// errores y el arranque del cliente Prisma sin tocar la base.

import { resolvePoolConfig } from "../../../src/lib/prisma-client.js";

const DEFAULTS = {
  maxConnections: 10,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 15_000,
} as const;

describe("resolvePoolConfig — defaults idénticos a los de siempre", () => {
  it("sin ninguna variable ⇒ 10 / 5000 / 15000", () => {
    expect(resolvePoolConfig({})).toEqual(DEFAULTS);
  });

  it("variables de OTROS nombres no afectan el pool", () => {
    expect(
      resolvePoolConfig({ DATABASE_URL: "postgresql://localhost/db", PORT: "3000" }),
    ).toEqual(DEFAULTS);
  });

  it("una sola variable definida deja los otros dos en default", () => {
    expect(resolvePoolConfig({ DATABASE_POOL_MAX: "25" })).toEqual({
      ...DEFAULTS,
      maxConnections: 25,
    });
  });
});

describe("resolvePoolConfig — variables de entorno", () => {
  it("las tres se leen como enteros", () => {
    expect(
      resolvePoolConfig({
        DATABASE_POOL_MAX: "20",
        DATABASE_CONNECTION_TIMEOUT_MS: "12000",
        DATABASE_STATEMENT_TIMEOUT_MS: "30000",
      }),
    ).toEqual({
      maxConnections: 20,
      connectionTimeoutMs: 12_000,
      statementTimeoutMs: 30_000,
    });
  });

  it("acepta 1 (el mínimo positivo)", () => {
    expect(
      resolvePoolConfig({
        DATABASE_POOL_MAX: "1",
        DATABASE_CONNECTION_TIMEOUT_MS: "1",
        DATABASE_STATEMENT_TIMEOUT_MS: "1",
      }),
    ).toEqual({ maxConnections: 1, connectionTimeoutMs: 1, statementTimeoutMs: 1 });
  });
});

describe("resolvePoolConfig — valor inválido ⇒ falla con mensaje accionable", () => {
  const INVALID: ReadonlyArray<readonly [string, string]> = [
    ["vacío", ""],
    ["cero", "0"],
    ["negativo", "-1"],
    ["decimal", "1.5"],
    ["con espacios", " 10"],
    ["con sufijo", "10ms"],
    ["no numérico", "muchas"],
    ["exponente", "1e3"],
    ["fuera del rango entero seguro", "99999999999999999999"],
  ];

  const VARIABLES: ReadonlyArray<readonly [string, number]> = [
    ["DATABASE_POOL_MAX", 10],
    ["DATABASE_CONNECTION_TIMEOUT_MS", 5_000],
    ["DATABASE_STATEMENT_TIMEOUT_MS", 15_000],
  ];

  it.each(
    VARIABLES.flatMap(([name, fallback]) =>
      INVALID.map(([label, value]) => [name, label, value, fallback] as const),
    ),
  )("%s (%s = \"%s\") ⇒ throw (default %s)", (name, _label, value, fallback) => {
    expect(() => resolvePoolConfig({ [name]: value })).toThrow(
      new RegExp(`${name} inválida .*${fallback}`),
    );
  });

  it("el mensaje incluye el valor recibido", () => {
    expect(() => resolvePoolConfig({ DATABASE_POOL_MAX: "0" })).toThrow(
      /DATABASE_POOL_MAX inválida \("0"\)/,
    );
  });

  it("no cae al default: la configuración inválida no devuelve nada", () => {
    expect(() =>
      resolvePoolConfig({ DATABASE_STATEMENT_TIMEOUT_MS: "abc" }),
    ).toThrow(/DATABASE_STATEMENT_TIMEOUT_MS/);
  });
});
