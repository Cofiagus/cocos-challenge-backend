// Sizing por monto (FASE 2 — Célula A): utilidad pura de amountArs.
// DECISIONS.md: `size = floor(amount / precio)` — nunca se compra/vende más
// de lo pedido; el residuo `amountArs − size × priceArs` queda como cash.
// Dinero siempre Decimal.

import { Decimal } from "decimal.js";

/**
 * Tamaño accionario entero derivable de un monto ARS a un precio dado
 * (DECISIONS.md): `sizeShares = floor(amountArs / priceArs)`.
 *
 * PURO: SOLO calcula el size. El REJECTED por `ZERO_SIZE` (size 0) lo decide
 * la capa de aplicación contra este resultado, y la validación de los
 * inputs (`amountArs > 0`, `price > 0` — PositiveArsInputSchema) es del
 * borde; si priceArs fuera 0 el caller ya lo rechazó con 400 antes.
 *
 * El residuo (`amountArs − sizeShares × priceArs`) es derivable por el
 * llamador a partir del retorno — no hace falta un tipo compuesto.
 */
export const sizeSharesFromAmountArs = (
  amountArs: Decimal,
  priceArs: Decimal,
): number => amountArs.div(priceArs).floor().toNumber();