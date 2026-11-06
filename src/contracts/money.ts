// Dinero del contrato — AGENTS.md: nunca float.
//
// Entrada (wire → Decimal): string decimal canónico de base 10 (D3). Un número
// JSON se RECHAZA aunque sea pequeño: el parser ya perdió cifras antes de que
// el contrato las vea. `ArsWireSchema`/`PositiveArsWireSchema` validan la forma
// (las reutiliza el espejo OpenAPI, sin transform); los `*InputSchema`
// transforman a `FinancialDecimal` para el dominio.
//
// Salida (Decimal → wire): "Salida: string con 2 decimales" (DECISIONS.md) —
// el valor se CUANTIZA A 2 DECIMALES EN Decimal y se emite como STRING con
// `.toFixed(2)`. NO se convierte a number: `Number("90071992547409.93")`
// devuelve ...94 y perdía un centavo. El agregado (cash, patrimonio) puede
// superar el máximo de una fila: es cota de columna, no de salida.
//
// Sin marcas nominales en la salida (decisión Q2=B de esta celda). Antes
// existían `MoneyArs = string & { __brand }` y `Pct = number & { __brand }`,
// pero el contrato HTTP se tipa con `z.infer`, que devuelve `string`/`number`:
// la marca se borraba en la única frontera donde debía proteger, así que no
// garantizaba nada y sugería una seguridad inexistente. Se eliminan en lugar
// de sostenerlas. El tipo que SÍ protege es la ENTRADA: `ArsInputSchema`
// transforma a `FinancialDecimal` (constructor aislado de 64 cifras) y los
// serializadores sólo aceptan ese tipo, de modo que un `Decimal` global o un
// `number` suelto no compila. La salida es, a propósito, `string`/`number`
// planos: lo que la valida es `MoneyArsSchema`/`PctSchema` al parsear.

import { z } from "zod";
import { FinancialDecimal } from "./financial-decimal.js";

/**
 * Gramática de un monto ARS SERIALIZADO (D3): string base 10 con exactamente
 * dos decimales, sin exponente ni ceros iniciales; `-0.00` está prohibido
 * (se normaliza a `0.00` en `serializeMoneyArs`). No lleva cota de magnitud:
 * los agregados de cash/patrimonio pueden superar el máximo de una fila.
 */
const MONEY_OUTPUT_GRAMMAR = /^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$/;

/**
 * Valida un money serializado: string canónico de exactamente 2 decimales.
 *
 * `z.string()` + `regex` en lugar de `z.custom`: `z.toJSONSchema` representa
 * el contrato OpenAPI (tipo string + pattern). La cuantización y la conversión
 * las hace `serializeMoneyArs`, no el schema.
 */
export const MoneyArsSchema = z
  .string({ error: "Se espera un string monetario con exactamente 2 decimales." })
  .regex(MONEY_OUTPUT_GRAMMAR, {
    message:
      "Se espera un string monetario canónico con exactamente 2 decimales (sin exponente, ceros iniciales ni signo +).",
  })
  .refine((value) => value !== "-0.00", {
    message: "El cero se serializa como 0.00, nunca como -0.00.",
  })
  .meta({
    description:
      "ARS como string con exactamente 2 decimales (cuantizado en Decimal antes de serializar).",
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

/**
 * Decimal → string de exactamente 2 decimales (HALF_UP), para la respuesta
 * HTTP. Cuantiza EN Decimal y usa `.toFixed(2)`: nunca pasa por `number`, que
 * perdía el centavo en valores como 90071992547409.93. Normaliza el cero
 * (incluido `-0.001`) a `0.00`. Un no-finito (NaN/Infinity) es un error de
 * programación/corrupción: falla ruidosamente en vez de emitir "Infinity".
 */
export const serializeMoneyArs = (amount: FinancialDecimal): string => {
  if (!amount.isFinite()) {
    throw new RangeError("No se serializa un monto no finito (NaN o infinito).");
  }
  const quantized = amount.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
  const normalized = quantized.isZero() ? new FinancialDecimal(0) : quantized;
  return normalized.toFixed(2);
};

/**
 * Decimal FINANCIERO (puntos porcentuales) → Pct: el contrato de porcentaje
 * sigue siendo `number` (D3) y sólo se convierte acá, con HALF_UP y finitud
 * validada.
 *
 * El parámetro es `FinancialDecimal` (el constructor aislado de 64 cifras), no
 * el `Decimal` global de 20: aceptar el global abría la puerta a un valor ya
 * redondeado por el singleton (cualquier `Decimal` suelto es asignable a
 * `Decimal`). Aceptar sólo el constructor del proyecto hace que el tipo
 * verifique la procedencia del número.
 *
 * Un Decimal finito puede exceder el rango de `number` (p. ej. `1e1000`): la
 * conversión devolvería `Infinity` y contaminaría el contrato con un valor que
 * `PctSchema` rechaza. Por eso se valida la finitud también DESPUÉS de
 * convertir, no sólo la del Decimal de entrada.
 */
export const serializePct = (pctX100: FinancialDecimal): number => {
  if (!pctX100.isFinite()) {
    throw new RangeError("No se serializa un porcentaje no finito (NaN o infinito).");
  }
  const pct = Number(
    pctX100.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2),
  );
  if (!Number.isFinite(pct)) {
    throw new RangeError(
      "No se serializa un porcentaje fuera del rango de number (no finito al convertir).",
    );
  }
  return pct;
};
