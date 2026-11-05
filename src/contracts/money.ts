// Dinero del contrato — AGENTS.md: nunca float.
//
// Entrada (wire → Decimal): string decimal canónico de base 10 (D3). Un número
// JSON se RECHAZA aunque sea pequeño: el parser ya perdió cifras antes de que
// el contrato las vea. `ArsWireSchema`/`PositiveArsWireSchema` validan la forma
// (las reutiliza el espejo OpenAPI, sin transform); los `*InputSchema`
// transforman a `FinancialDecimal` para el dominio.
//
// Salida (Decimal → wire): "Salida: números con 2 decimales" (DECISIONS.md) —
// el valor se CUANTIZA A 2 DECIMALES EN Decimal ANTES de la conversión final;
// el `number` del tipo MoneyArs es sólo el vehículo de serialización de JSON,
// el último double es la repr más corta del decimal de 2 cifras. Ningún
// cálculo se hace jamás en float.

import { z } from "zod";
import { Decimal } from "decimal.js";
import { FinancialDecimal } from "./financial-decimal.js";

/** Dinero ARS serializado: número JSON con a lo sumo 2 decimales. */
export type MoneyArs = number & { readonly __brand: "MoneyArs" };

/** Porcentaje serializado (puntos porcentuales, 2 decimales). */
export type Pct = number & { readonly __brand: "Pct" };

/**
 * Valida un money serializado: número finito y ≤2 decimales.
 *
 * `z.number()` + `refine` en lugar de `z.custom`: `z.toJSONSchema` no puede representar tipos
 * custom ("Custom types cannot be represented in JSON Schema") y este schema viaja dentro de las
 * respuestas del contrato OpenAPI. La regla de 2 decimales viaja SOLO en la `description`:
 * un `multipleOf: 0.01` en el JSON Schema se valida con división float (0.07/0.01 =
 * 7.000000000000001) y hace que validadores estrictos (ajv) rechacen respuestas VÁLIDAS.
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
  });

/** Valida un porcentaje serializado: número finito, 2 decimales. */
export const PctSchema = z
  .number()
  .refine((value) => Number.isFinite(value), {
    message: "Se espera un número finito.",
  })
  // Sin `multipleOf` por lo mismo que MoneyArsSchema: la división float del validador
  // rechazaría porcentajes válidos (la cuantización a 2 decimales la hace serializePct).
  .meta({ description: "Porcentaje en puntos (2 decimales)." });

/**
 * Gramática de un monto ARS en el wire (D3): base 10, punto decimal, sin
 * exponente, espacios, separador de miles, signo `+` ni ceros iniciales salvo
 * el propio `0`; hasta 2 decimales. El techo de DÍGITOS ENTEROS (22) NO se
 * repite acá: sale del único máximo, `MAX_STORED_ARSS` — una sola definición
 * de rango y gramática (spec §3.2).
 */
const ARS_WIRE_GRAMMAR = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;

const ARS_WIRE_SHAPE_MESSAGE =
  "Se espera un string decimal canónico de base 10 (punto decimal, a lo sumo 2 decimales, sin exponente, espacios, signo +, separador de miles ni ceros iniciales); el número JSON no se acepta.";

/**
 * Máximo por importe/precio almacenado: NUMERIC(24,2) de D1. Única definición
 * del rango monetario: los schemas de entrada (y, en wire, los de salida) la
 * reutilizan en vez de duplicar la constante. Es una cota de COLUMNA, no del
 * patrimonio: sumas/productos agregados pueden superarla y siguen siendo
 * válidos (el schema de salida NO la aplica).
 */
export const MAX_STORED_ARSS = new FinancialDecimal("9999999999999999999999.99");

const ARS_WIRE_MAX_MESSAGE = `El monto debe ser, en valor absoluto, a lo sumo ${MAX_STORED_ARSS.toFixed(2)}.`;

/** Parsea la forma válida; `null` si no es un decimal parseable (nunca lanza). */
const parseWireAmount = (value: string): FinancialDecimal | null => {
  try {
    return new FinancialDecimal(value);
  } catch {
    return null;
  }
};

/** |monto| ≤ máximo de columna. Reutiliza `MAX_STORED_ARSS`, sin otra cota. */
const withinMaxStoredArss = (value: string): boolean => {
  const amount = parseWireAmount(value);
  return amount !== null && amount.abs().lessThanOrEqualTo(MAX_STORED_ARSS);
};

const greaterThanZero = (value: string): boolean => {
  const amount = parseWireAmount(value);
  return amount !== null && amount.greaterThan(0);
};

const arsWireString = z
  .string({
    error: "Se espera un string decimal; los números JSON no se aceptan.",
  })
  .regex(ARS_WIRE_GRAMMAR, { message: ARS_WIRE_SHAPE_MESSAGE })
  .refine(withinMaxStoredArss, { message: ARS_WIRE_MAX_MESSAGE });

/**
 * Monto ARS en el wire (D3): string canónico, SIN transformar. Pensado para el
 * espejo OpenAPI (`z.toJSONSchema` representable: tipo string + pattern).
 */
export const ArsWireSchema = arsWireString.meta({
  description: `ARS como string decimal canónico de base 10, hasta 2 decimales y ${MAX_STORED_ARSS.toFixed(2)} en valor absoluto. Sin exponente, espacios, signo + ni ceros iniciales.`,
});

/** Monto ARS en el wire estrictamente positivo (amountArs > 0, price > 0). */
export const PositiveArsWireSchema = arsWireString
  .refine(greaterThanZero, { message: "El monto debe ser mayor que 0." })
  .meta({
    description: `ARS como string decimal canónico de base 10, mayor que 0 y hasta ${MAX_STORED_ARSS.toFixed(2)}.`,
  });

/**
 * Dinero ARS de entrada: string canónico (mismo grammar y cota que
 * `ArsWireSchema`) transformado al constructor financiero. Puede ser negativo
 * o cero; la positividad es del `PositiveArsInputSchema`.
 */
export const ArsInputSchema = ArsWireSchema.transform(
  (value) => new FinancialDecimal(value),
);

/** Dinero ARS de entrada estrictamente positivo (amountArs > 0, price > 0). */
export const PositiveArsInputSchema = PositiveArsWireSchema.transform(
  (value) => new FinancialDecimal(value),
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
