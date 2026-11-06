// Garantía NOMINAL de FinancialDecimal — compilación, no convención.
//
// El tipo instancia de `Decimal.clone(...)` es ESTRUCTURALMENTE idéntico al del
// `Decimal` global: sin marca, `serializeMoneyArs(unDecimalGlobal)` compilaba y
// la protección era decorativa. `src/contracts/financial-decimal.ts` agrega un
// `unique symbol` que sólo produce ese módulo, así que un `Decimal` global deja
// de ser asignable.
//
// Cómo se demuestra acá:
//  1. `globalDecimalIsAssignableToBranded` es una comprobación de TIPOS: vale
//     `false` sólo mientras el global no tenga la marca. Si alguien la quitara,
//     el literal `false` dejaría de tipar y `npm run typecheck` fallaría.
//  2. `@ts-expect-error` en los llamados reales a los serializadores: si el
//     llamado compilara, tsc reportaría TS2578 (directiva sin error) y el
//     typecheck volvería a fallar. Mismo mecanismo que un `assert` de tipos.
// No hay casts, ni `any`, ni supresión de diagnóstico (`@ts-ignore`).

import { Decimal } from "decimal.js";
import {
  serializeMoneyArs,
  serializePct,
} from "../../src/contracts/money.js";
import { FinancialDecimal } from "../../src/contracts/financial-decimal.js";

/** `true` sólo si un `Decimal` global fuese aceptable donde se espera la marca. */
type IsAssignable<From, To> = [From] extends [To] ? true : false;

const globalDecimalIsAssignableToBranded: IsAssignable<
  Decimal,
  FinancialDecimal
> = false;

/**
 * Contraejemplos compilados: NO se ejecuta en runtime (el valor de un `Decimal`
 * global es compatible; lo que se rechaza es el TIPO). Vive en un módulo que
 * `npm run typecheck` compila, así que la directiva es parte del gate.
 */
export const globalDecimalIsRejectedBySerializers = (): void => {
  const globalDecimal = new Decimal("123.45");

  // @ts-expect-error TS2345 — un Decimal global (20 cifras) no es FinancialDecimal.
  serializeMoneyArs(globalDecimal);

  // @ts-expect-error TS2345 — idem para el porcentaje: sólo entra el de 64 cifras.
  serializePct(globalDecimal);

  // @ts-expect-error TS2322 — tampoco sirve como acumulador financiero marcado.
  const branded: FinancialDecimal = globalDecimal;

  // Referencia al valor para que la variable no quede sin uso (lint).
  expect(serializeMoneyArs(branded)).toBe("123.45");
};

describe("FinancialDecimal — marca nominal", () => {
  it("el constructor y la aritmética conservan la marca (sin casts)", () => {
    const amount: FinancialDecimal = new FinancialDecimal("123.45");
    const total: FinancialDecimal = amount.plus("1.00").mul("2");
    const rounded: FinancialDecimal = total.toDecimalPlaces(
      2,
      FinancialDecimal.ROUND_HALF_UP,
    );

    expect(serializeMoneyArs(total)).toBe("248.90");
    expect(serializeMoneyArs(rounded)).toBe("248.90");
    expect(serializePct(new FinancialDecimal("1.5"))).toBe(1.5);
  });

  it("un Decimal global NO es asignable a FinancialDecimal", () => {
    // Comprobación de tipos: si la marca desapareciera, valdría `true` y el
    // `false` de la declaración dejaría de compilar.
    expect(globalDecimalIsAssignableToBranded).toBe(false);
    // Los contraejemplos están compilados arriba con @ts-expect-error: que
    // `npm run typecheck` dé 0 es la prueba de que NO compilan.
    expect(typeof globalDecimalIsRejectedBySerializers).toBe("function");
  });
});
