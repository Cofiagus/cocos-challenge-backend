// Dinero del contrato — AGENTS.md: nunca float.
//
// Entrada (wire → Decimal): "Entrada: número o string parseado con Decimal"
// (DECISIONS.md). Un JSON number se convierte con String(value) (repr más
// corta exacta) y NUNCA con new Decimal(number).
//
// Salida (Decimal → wire): "Salida: números con 2 decimales" (DECISIONS.md) —
// el valor se CUANTIZA A 2 DECIMALES EN Decimal ANTES de la conversión final;
// el `number` del tipo MoneyArs es sólo el vehículo de serialización de JSON,
// el último double es la repr más corta del decimal de 2 cifras. Ningún
// cálculo se hace jamás en float.

import { Decimal } from "decimal.js";
import { z } from "zod";

/** Dinero ARS serializado: número JSON con a lo sumo 2 decimales. */
export type MoneyArs = number & { readonly __brand: "MoneyArs" };

/** Porcentaje serializado (puntos porcentuales, 2 decimales). */
export type Pct = number & { readonly __brand: "Pct" };

/**
 * Valida un money serializado: número finito y ≤2 decimales.
 *
 * `z.number()` + `refine` en lugar de `z.custom`: `z.toJSONSchema` no puede representar tipos
 * custom ("Custom types cannot be represented in JSON Schema") y este schema viaja dentro de las
 * respuestas del contrato OpenAPI. `.meta()` agrega la anotación JSON Schema (`multipleOf`) SIN
 * cambiar la validación en runtime.
 */
export const MoneyArsSchema = z
  .number()
  .refine(
    (value) =>
      Number.isFinite(value) &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
    { message: "Se espera un número finito con a lo sumo 2 decimales." },
  )
  .meta({
    description:
      "ARS con 2 decimales (número JSON; el valor se cuantizó en Decimal antes de serializar).",
    multipleOf: 0.01,
  });

/** Valida un porcentaje serializado: número finito, 2 decimales. */
export const PctSchema = z
  .number()
  .refine((value) => Number.isFinite(value), {
    message: "Se espera un número finito.",
  })
  .meta({ description: "Porcentaje en puntos (2 decimales).", multipleOf: 0.01 });

const decimalFromWire = (value: unknown): unknown => {
  if (typeof value === "number") {
    return new Decimal(String(value));
  }
  if (typeof value === "string") {
    try {
      return new Decimal(value.trim());
    } catch {
      return undefined;
    }
  }
  return value;
};

/**
 * Dinero ARS de entrada (amountArs, price): número o string, parseado con
 * Decimal. Rechaza basura y no-finitos (NaN/Infinity del string).
 */
export const ArsInputSchema = z.preprocess(
  decimalFromWire,
  z.instanceof(Decimal),
).refine((amount) => amount.isFinite(), {
  message: "Monto inválido (no numérico, NaN o infinito).",
});

/** Dinero ARS de entrada estrictamente positivo (amountArs > 0, price > 0). */
export const PositiveArsInputSchema = ArsInputSchema.refine(
  (amount) => amount.greaterThan(0),
  { message: "El monto debe ser mayor que 0." },
);

/** Decimal → MoneyArs (2 decimales, HALF_UP), para la respuesta HTTP. */
export const serializeMoneyArs = (amount: Decimal): MoneyArs =>
  Number(
    amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  ) as MoneyArs;

/** Decimal (puntos porcentuales) → Pct (2 decimales, HALF_UP). */
export const serializePct = (pctX100: Decimal): Pct =>
  Number(
    pctX100.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  ) as Pct;
