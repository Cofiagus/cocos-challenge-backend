// Constructor Decimal financiero — D1: 64 cifras significativas, ROUND_HALF_UP.
//
// Es un `clone` de decimal.js: configuración propia del contrato, aislada del
// singleton del paquete. Importar este módulo NO cambia `Decimal.precision`
// (sigue 20) ni depende del orden de imports ni de una mutación en el arranque.
//
// Presupuesto (spec §3, D1): precio máximo × acciones por orden × órdenes
// positivas ronda las 43 cifras; 64 deja margen para esos productos y sumas.
// No es precisión infinita: las divisiones periódicas siguen expandiéndose.
//
// Vive en contracts para que dominio e infra lo consuman sin invertir
// dependencias. Todo valor financiero se construye DESDE STRING: un `number`
// ya perdió cifras antes de llegar acá.
//
// MARCA NOMINAL (f3-clean): el tipo instancia de un `clone` es
// ESTRUCTURALMENTE idéntico al del `Decimal` global (mismo `d`/`e`/`s` y las
// mismas firmas), así que declarar los serializadores con ese tipo no impedía
// pasar un `Decimal` de 20 cifras: compilaba igual y la protección era
// decorativa. El tipo de abajo lleva una marca (`unique symbol`) que sólo
// produce este módulo, de modo que un `Decimal` global ya NO es asignable a
// `FinancialDecimal`. La marca es SÓLO de tipo: no agrega campos en runtime ni
// cambia el valor.

import { Decimal } from "decimal.js";

/** Constructor financiero del proyecto: 64 cifras, HALF_UP. */
const FinancialDecimalBase = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_UP,
});

/** Marca nominal de las instancias financieras (no existe en runtime). */
declare const FINANCIAL_DECIMAL_MARK: unique symbol;

/**
 * Sobrecargas que el mapeo NO puede reescribir: un condicional
 * `(...args) => Decimal` colapsa una función sobrecargada a su última firma y
 * deja de ser asignable a la de `Decimal` (rompía `Decimal.Value`). Se
 * declaran a mano, con las dos firmas del paquete y el retorno marcado.
 */
interface BrandedOverloads {
  toDecimalPlaces(decimalPlaces?: number): FinancialDecimal;
  toDecimalPlaces(
    decimalPlaces: number,
    rounding: Decimal.Rounding,
  ): FinancialDecimal;
  toDP(decimalPlaces?: number): FinancialDecimal;
  toDP(decimalPlaces: number, rounding: Decimal.Rounding): FinancialDecimal;
  toSignificantDigits(significantDigits?: number): FinancialDecimal;
  toSignificantDigits(
    significantDigits: number,
    rounding: Decimal.Rounding,
  ): FinancialDecimal;
  toSD(significantDigits?: number): FinancialDecimal;
  toSD(
    significantDigits: number,
    rounding: Decimal.Rounding,
  ): FinancialDecimal;
}

/** Métodos sobrecargados reescritos a mano (fuera del mapeo). */
type OverloadedMethod = keyof BrandedOverloads;

/**
 * Tipo de las instancias del constructor financiero (mismo nombre en el
 * namespace de tipos y de valores).
 *
 * El mapeo reescribe las firmas que devuelven `Decimal` para que devuelvan
 * `FinancialDecimal`: sin eso, `amount.plus(x)` devolvería el `Decimal`
 * global y la marca se perdería en la primera operación, obligando a castear
 * en cada cálculo del dominio. Los PARÁMETROS se dejan como `Decimal.Value`
 * (un `Decimal` global sigue siendo un valor de entrada legítimo: lo que no
 * se acepta es un global COMO acumulador financiero).
 */
export type FinancialDecimal = {
  readonly [K in Exclude<keyof Decimal, OverloadedMethod>]: Decimal[K] extends (
    ...args: infer Args
  ) => Decimal
    ? (...args: Args) => FinancialDecimal
    : Decimal[K];
} & BrandedOverloads & {
    readonly [FINANCIAL_DECIMAL_MARK]: typeof FINANCIAL_DECIMAL_MARK;
  };

/**
 * Cara estática del constructor exportado: construye instancias marcadas y
 * conserva los statics que el código usa (`ROUND_HALF_UP`, `precision`,
 * `rounding`, `min`, `max`). `min`/`max` también devuelven la marca: el precio
 * de fill con mejora sale de ahí.
 */
interface FinancialDecimalConstructor {
  new (value: Decimal.Value): FinancialDecimal;
  readonly ROUND_HALF_UP: Decimal.Rounding;
  readonly precision: number;
  readonly rounding: Decimal.Rounding;
  min(...values: Decimal.Value[]): FinancialDecimal;
  max(...values: Decimal.Value[]): FinancialDecimal;
}

/**
 * Única aserción del módulo: el `clone` en runtime no puede declarar la marca
 * (es de tipo), así que la cara estática se declara acá una sola vez. El resto
 * del repo consume el tipo ya marcado, sin casts.
 */
export const FinancialDecimal = FinancialDecimalBase as unknown as FinancialDecimalConstructor;
