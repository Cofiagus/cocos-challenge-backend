// Precio de ejecución de la proyección FILLED de orders (sin DB): las
// FILLED de la API lo guardan en `filledPrice` (price queda en el límite o
// NULL) y las heredadas del dataset en `price`. El mapper debe leer
// `filledPrice ?? price` y fallar fuerte sólo si AMBOS son NULL — una fila
// así es corrupción, no se normaliza en silencio.

import { Prisma, type Order } from "@prisma/client";
import { CorruptRowError } from "../../../src/infra/prisma/corrupt-row.error.js";
import { mapSettledMovementRow } from "../../../src/infra/prisma/mappers.js";

const decimalOrNull = (value: string | null): Prisma.Decimal | null =>
  value === null ? null : new Prisma.Decimal(value);

/** Fila FILLED mínima: sólo importan los dos precios para este mapper. */
const filledOrderRow = (
  price: string | null,
  filledPrice: string | null,
): Order => ({
  id: 1,
  instrumentId: 47,
  userId: 1,
  size: 10,
  price: decimalOrNull(price),
  type: "LIMIT",
  side: "BUY",
  status: "FILLED",
  datetime: new Date("2023-07-14T00:00:00.000Z"),
  timeInForce: "GTC",
  filledPrice: decimalOrNull(filledPrice),
  filledAt: new Date("2023-07-14T00:00:00.000Z"),
  idempotencyKey: null,
});

describe("mapSettledMovementRow — precio de ejecución", () => {
  it("filledPrice con price NULL: usa filledPrice", () => {
    const movement = mapSettledMovementRow(
      filledOrderRow(null, "1502.80"),
    );
    expect(movement.priceArs.toFixed(2)).toBe("1502.80");
  });

  it("filledPrice NULL con price: usa price (FILLED heredada del dataset)", () => {
    const movement = mapSettledMovementRow(
      filledOrderRow("1502.80", null),
    );
    expect(movement.priceArs.toFixed(2)).toBe("1502.80");
  });

  it("ambos NULL: falla fuerte con CorruptRowError", () => {
    expect(() => mapSettledMovementRow(filledOrderRow(null, null))).toThrow(
      CorruptRowError,
    );
    expect(() => mapSettledMovementRow(filledOrderRow(null, null))).toThrow(
      /orders\(FILLED\)\.filledPrice\|price/,
    );
  });

  it("ambos con valor: gana filledPrice (la ejecución, no el límite)", () => {
    const movement = mapSettledMovementRow(
      filledOrderRow("999.00", "1502.80"),
    );
    expect(movement.priceArs.toFixed(2)).toBe("1502.80");
  });
});
