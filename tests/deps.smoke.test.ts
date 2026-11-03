import { Decimal } from "decimal.js";
import { z } from "zod";

// Humo de toolchain (FASE 0): prueba que zod y decimal.js importan y funcionan,
// respetando las reglas de dinero de AGENTS.md — Decimal desde strings, nunca
// desde number.

const OrderInputSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  size: z.number().int().positive(),
  priceCents: z.number().int().positive(),
});

describe("smoke: zod + decimal.js", () => {
  it("zod parsea input de orden válido", () => {
    const parsed = OrderInputSchema.safeParse({
      side: "BUY",
      size: 10,
      priceCents: 93000,
    });
    expect(parsed.success).toBe(true);
  });

  it("zod rechaza input inválido sin cast silencioso", () => {
    const parsed = OrderInputSchema.safeParse({
      side: "SHORT",
      size: 10,
      priceCents: 93000,
    });
    expect(parsed.success).toBe(false);
  });

  it("decimal.js hace aritmética exacta construido desde strings", () => {
    const feeCents = new Decimal("3550000")
      .mul(new Decimal("0.001"))
      .toDecimalPlaces(0, Decimal.ROUND_DOWN);
    expect(feeCents.toString()).toBe("3550");

    // Con float esto daría 0.30000000000000004; con Decimal es exacto.
    expect(new Decimal("0.1").add("0.2").equals(new Decimal("0.3"))).toBe(true);
  });
});
