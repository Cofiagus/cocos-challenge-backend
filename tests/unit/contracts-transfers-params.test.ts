// D-06 — params de POST /api/users/:userId/transfers: `userId` se persiste en
// una columna Int (INT4). La cota compartida (PositiveIntParamSchema, definida
// en contracts/orders junto a MAX_INT4) hace que un id fuera de rango falle en
// el borde (400) en vez de golpear el SELECT como error de Postgres
// (SQLSTATE 22003 / Prisma P2020 ⇒ 500).
//
// La misma cota la usan CreateOrderParamsSchema, CancelOrderParamsSchema y
// PortfolioParamsSchema: acá se verifica que transfers no vuelva a declarar su
// propio `z.coerce.number().int().positive()` sin techo.

import { MAX_INT4 } from "../../src/contracts/orders.js";
import { CreateTransferParamsSchema } from "../../src/contracts/transfers.js";

/** ¿El valor pasa el schema? (400 del borde ⇔ safeParse falla). */
const accepts = (userId: unknown): boolean =>
  CreateTransferParamsSchema.safeParse({ userId }).success;

/** `userId` ya parseado, o undefined si el borde lo rechaza. */
const parsedUserId = (userId: unknown): number | undefined => {
  const result = CreateTransferParamsSchema.safeParse({ userId });
  return result.success ? result.data.userId : undefined;
};

describe("CreateTransferParamsSchema — userId acotado a INT4", () => {
  it("acepta el borde superior INT4 (2147483647)", () => {
    expect(accepts(MAX_INT4)).toBe(true);
    expect(accepts(String(MAX_INT4))).toBe(true);
    expect(parsedUserId(MAX_INT4)).toBe(MAX_INT4);
  });

  it("rechaza INT4+1 (2147483648) antes de tocar la DB", () => {
    expect(accepts(2147483648)).toBe(false);
    expect(accepts("2147483648")).toBe(false);
  });

  it("rechaza el entero seguro de JS (2^53−1), que sin la cota pasaba Zod", () => {
    expect(accepts(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(accepts(String(Number.MAX_SAFE_INTEGER))).toBe(false);
  });

  it("rechaza 0, negativos, fracciones y no numéricos", () => {
    for (const userId of [0, -1, 1.5, "0", "-1", "1.5", "abc", "", null]) {
      expect(accepts(userId)).toBe(false);
    }
  });

  it('coacciona "7" (param de ruta de Express) a userId === 7', () => {
    expect(parsedUserId("7")).toBe(7);
    expect(typeof parsedUserId("7")).toBe("number");
  });

  it("rechaza un body sin userId y un objeto con claves extra (strictObject)", () => {
    expect(CreateTransferParamsSchema.safeParse({}).success).toBe(false);
    expect(
      CreateTransferParamsSchema.safeParse({ userId: "7", extra: "x" }).success,
    ).toBe(false);
  });
});

describe("CreateTransferParamsSchema — coerción numérica de params", () => {
  // Zod coacciona con Number(), que acepta notación exponencial y hexadecimal.
  // Esas formas se normalizan a un entero dentro de rango (nunca desbordan
  // INT4), así que el borde responde 404 por id inexistente y no 500.
  it("normaliza notación exponencial y hexadecimal a un entero en rango", () => {
    expect(parsedUserId("1e3")).toBe(1000);
    expect(parsedUserId("0x10")).toBe(16);
  });

  it("ninguna forma coaccionada supera INT4", () => {
    for (const userId of ["1e10", "0x80000000", "1e3.5", "-1e3"]) {
      expect(accepts(userId)).toBe(false);
    }
  });
});
