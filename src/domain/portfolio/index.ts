// Firmas del dominio de portfolio — FASE 1 (Célula 0): SOLO firmas.
// La célula A de FASE 2 implementa contra DECISIONS.md; el dominio es PURO
// (sin Prisma, sin Express, sin I/O). Dinero siempre Decimal.
//
// Los parámetros llevan `_` porque el cuerpo de FASE 1 no los usa
// (noUnusedParameters); la célula A los renombra al implementar.

import { Decimal } from "decimal.js";
import type {
  MarketdataSnapshot,
  PositionPnl,
  Reservations,
  RestingOrder,
  SettledOrderMovement,
} from "../../contracts/index.js";

/**
 * Cash liquidado (cashSettled) de los movimientos FILLED de un usuario:
 * Σ CASH_IN size×price − CASH_OUT size×price + SELL size×price − BUY
 * size×price (docs/database.md §3). Devuelve 0 si no hay movimientos.
 */
export const deriveCash = (
  _settledMovements: readonly SettledOrderMovement[],
): Decimal => {
  throw new Error("not implemented");
};

/**
 * Reservas derivadas de las órdenes NEW de un usuario (sin tabla —
 * DECISIONS.md): BUY reserva limit × size de cash; SELL reserva size
 * acciones. El cash disponible es cashSettled − cashReservedArs.
 */
export const deriveReservations = (
  _restingOrders: readonly RestingOrder[],
): Reservations => {
  throw new Error("not implemented");
};

/**
 * Costo promedio ponderado de las compras (side BUY) de UN instrumento:
 * cada compra sube el promedio; las ventas bajan la cantidad sin tocar el
 * promedio (DECISIONS.md). 0 si no hay compras.
 */
export const weightedAverageCost = (
  _buyMovements: readonly SettledOrderMovement[],
): Decimal => {
  throw new Error("not implemented");
};

/**
 * Posiciones con P&L no realizado de un usuario a partir de sus
 * movimientos FILLED de trading (BUY/SELL; CASH_* no son posiciones) y los
 * precios de referencia disponibles.
 *
 * Reglas (DECISIONS.md):
 *  - posición con cantidad 0 NO se lista;
 *  - posición negativa (BMA −10 del seed) se lista tal cual;
 *  - sin precio de referencia: marketValueArs null, priceAvailable false,
 *    totalReturnPctX100 null (no suma al total);
 *  - costo 0 (sólo ventas): totalReturnPctX100 null.
 */
export const derivePositions = (
  _settledMovements: readonly SettledOrderMovement[],
  _marketdataSnapshots: readonly MarketdataSnapshot[],
): readonly PositionPnl[] => {
  throw new Error("not implemented");
};