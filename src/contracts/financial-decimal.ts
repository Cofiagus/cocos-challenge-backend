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

import { Decimal } from "decimal.js";

/** Constructor financiero del proyecto: 64 cifras, HALF_UP. */
export const FinancialDecimal = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Tipo de las instancias del constructor financiero (mismo nombre en el
 * namespace de tipos y de valores). Es el tipo instancia de decimal.js.
 */
export type FinancialDecimal = InstanceType<typeof FinancialDecimal>;
