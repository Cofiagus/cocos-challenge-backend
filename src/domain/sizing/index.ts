// Sizing por monto: utilidad pura de amountArs.
// DECISIONS.md: `size = floor(amount / precio)` — nunca se compra/vende más
// de lo pedido; el residuo `amountArs − size × priceArs` queda como cash.
// Dinero siempre en el constructor financiero (AGENTS.md: nunca float).
//
// D2/D5 (spec grandes montos): el retorno SIGUE siendo number porque las
// acciones POR ORDEN están acotadas a INT4. El floor se calcula en Decimal y
// el rango 0..MAX_ORDER_SIZE_SHARES se valida ANTES de `toNumber`: un valor
// que no cabe en el contrato lanza RangeError (el borde lo mapea a 400 sin
// INSERT), nunca se convierte en un entero inseguro ni en Infinity.

import {
  FinancialDecimal,
  MAX_ORDER_SIZE_SHARES,
} from "../../contracts/index.js";

/** Cota de acciones por orden (INT4) en el constructor financiero, desde string. */
const MAX_SIZE_SHARES = new FinancialDecimal(String(MAX_ORDER_SIZE_SHARES));

/** size válido: entero y dentro de 0..INT4 (0 conserva el REJECTED ZERO_SIZE). */
const isValidSizeShares = (sizeShares: FinancialDecimal): boolean =>
  sizeShares.isFinite() &&
  sizeShares.isInteger() &&
  sizeShares.greaterThanOrEqualTo(0) &&
  sizeShares.lessThanOrEqualTo(MAX_SIZE_SHARES);

/**
 * Tamaño accionario entero derivable de un monto ARS a un precio dado
 * (DECISIONS.md): `sizeShares = floor(amountArs / priceArs)`.
 *
 * PURO: SOLO calcula el size. El REJECTED por `ZERO_SIZE` (size 0) lo decide
 * la capa de aplicación contra este resultado, y la validación de los
 * inputs (`amountArs > 0`, `price > 0` — PositiveArsInputSchema) es del
 * borde; si priceArs fuera 0 el caller ya lo rechazó con 400 antes.
 *
 * Fuera de rango (no finito, fraccionario, negativo o > MAX_ORDER_SIZE_SHARES)
 * lanza RangeError: es un error de contrato, no un REJECTED de negocio.
 *
 * El residuo (`amountArs − sizeShares × priceArs`) es derivable por el
 * llamador a partir del retorno — no hace falta un tipo compuesto.
 */
export const sizeSharesFromAmountArs = (
  amountArs: FinancialDecimal,
  priceArs: FinancialDecimal,
): number => {
  const sizeShares = amountArs.div(priceArs).floor();
  if (!isValidSizeShares(sizeShares)) {
    throw new RangeError(
      `El size derivado no es un entero entre 0 y ${MAX_ORDER_SIZE_SHARES}.`,
    );
  }
  return sizeShares.toNumber();
};
