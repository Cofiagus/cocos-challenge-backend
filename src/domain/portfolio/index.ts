// Dominio de portfolio: funciones PURAS de derivación.
// Sin Prisma, sin Express, sin I/O ni reloj: la única fuente de verdad es la
// lista de movimientos/órdenes que el llamador ya leyó (capa de aplicación,
// dentro de la misma tx de validación). Dinero SIEMPRE Decimal (AGENTS.md).
//
// Reglas en DECISIONS.md; proyección de orders en docs/database.md §3.

import { Decimal } from "decimal.js";
import type {
  MarketdataSnapshot,
  PositionPnl,
  Reservations,
  RestingOrder,
  SettledOrderMovement,
} from "../../contracts/index.js";

/** 100, para el retorno porcentual — Decimal, nunca float. */
const HUNDRED = new Decimal(100);

/** Cantidad de acciones (entero) → Decimal sin pasar por float. */
const sizeAsDecimal = (sizeShares: number): Decimal => new Decimal(String(sizeShares));

/** Notional de un movimiento: size × precio de ejecución (exacto en Decimal). */
const notionalArs = (movement: SettledOrderMovement): Decimal =>
  sizeAsDecimal(movement.sizeShares).mul(movement.priceArs);

/**
 * Cash liquidado (cashSettled) de los movimientos FILLED de un usuario:
 * Σ CASH_IN size×price − CASH_OUT size×price + SELL size×price − BUY
 * size×price (docs/database.md §3). 0 si no hay movimientos.
 *
 * PURA: no mira reservas (NEW no mueve plata — el cash disponible es
 * `deriveCash(...) − deriveReservations(...).cashReservedArs`, resta que
 * hace la capa de aplicación).
 */
export const deriveCash = (
  settledMovements: readonly SettledOrderMovement[],
): Decimal =>
  settledMovements.reduce<Decimal>(
    (cash, movement) =>
      cash.plus(
        movement.side === "CASH_OUT" || movement.side === "BUY"
          ? notionalArs(movement).neg()
          : notionalArs(movement),
      ),
    new Decimal(0),
  );

/**
 * Reservas derivadas de las órdenes NEW de un usuario (sin tabla —
 * DECISIONS.md): cada BUY reserva `limit × size` de cash; cada SELL reserva
 * `size` acciones de SU instrumento. El cash disponible es
 * `cashSettled − cashReservedArs` (CASH_OUT valida contra eso).
 *
 * Los BUY no reservan acciones ni crean entrada en el mapa: sólo los
 * instrumentos con SELL NEW aparecen. Sin órdenes ⇒ cash 0 y mapa vacío.
 */
export const deriveReservations = (
  restingOrders: readonly RestingOrder[],
): Reservations => {
  let cashReservedArs = new Decimal(0);
  const sharesReservedByInstrument = new Map<number, number>();

  for (const order of restingOrders) {
    if (order.side === "BUY") {
      cashReservedArs = cashReservedArs.plus(
        sizeAsDecimal(order.sizeShares).mul(order.limitPriceArs),
      );
    } else {
      const reserved = sharesReservedByInstrument.get(order.instrumentId) ?? 0;
      sharesReservedByInstrument.set(
        order.instrumentId,
        reserved + order.sizeShares,
      );
    }
  }

  return { cashReservedArs, sharesReservedByInstrument };
};

/**
 * Costo promedio ponderado de las compras (side BUY) de UN instrumento:
 * Σ(size × price) / Σ size. Las ventas bajan la cantidad SIN tocar el
 * promedio (DECISIONS.md: P&L no realizado sobre costo promedio ponderado);
 * por eso esta función sólo mira las compras. 0 si no hay compras
 * (posición heredada sin buys).
 *
 * El llamador agrupa por instrumento antes de llamar (no hay filtrado
 * acá): la agrupación es de la capa de aplicación o de derivePositions.
 */
export const weightedAverageCost = (
  buyMovements: readonly SettledOrderMovement[],
): Decimal => {
  let totalCostArs = new Decimal(0);
  let totalShares = 0;

  for (const movement of buyMovements) {
    if (movement.side !== "BUY") continue;
    totalCostArs = totalCostArs.plus(notionalArs(movement));
    totalShares += movement.sizeShares;
  }

  if (totalShares === 0) return new Decimal(0);
  return totalCostArs.div(sizeAsDecimal(totalShares));
};

/**
 * Posiciones con P&L no realizado de un usuario a partir de sus movimientos
 * FILLED de trading y los precios de referencia disponibles.
 *
 * Reglas (DECISIONS.md):
 *  - sólo BUY/SELL son posiciones (CASH_IN/CASH_OUT se ignoran);
 *  - quantity = Σ size BUY − Σ size SELL, por instrumento;
 *  - posición con cantidad 0 NO se lista;
 *  - posición negativa (BMA −10 del seed) se devuelve tal cual;
 *  - costo promedio ponderado sobre las COMPRAS (las ventas no lo tocan);
 *  - sin snapshot de marketdata: marketValueArs null, priceAvailable false,
 *    totalReturnPctX100 null (la posición no suma al total, arriba);
 *  - costo 0 (posición sin compras): totalReturnPctX100 null.
 *
 * ORDEN DETERMINÍSTICO: el resultado sale ordenado por instrumentId
 * ASCENDENTE, sin depender del orden de las filas leídas ni del mapa
 * interno (los ids se ordenan antes de armar la lista). Igualar dos runs
 * con las mismas filas en distinto orden da la misma lista.
 */
export const derivePositions = (
  settledMovements: readonly SettledOrderMovement[],
  marketdataSnapshots: readonly MarketdataSnapshot[],
): readonly PositionPnl[] => {
  const quantityByInstrument = new Map<number, number>();
  const buyMovementsByInstrument = new Map<number, SettledOrderMovement[]>();

  for (const movement of settledMovements) {
    if (movement.side !== "BUY" && movement.side !== "SELL") continue;

    const currentQuantity =
      quantityByInstrument.get(movement.instrumentId) ?? 0;
    const signedQuantity =
      movement.side === "BUY" ? movement.sizeShares : -movement.sizeShares;
    quantityByInstrument.set(
      movement.instrumentId,
      currentQuantity + signedQuantity,
    );

    if (movement.side === "BUY") {
      const buys =
        buyMovementsByInstrument.get(movement.instrumentId) ?? [];
      buys.push(movement);
      buyMovementsByInstrument.set(movement.instrumentId, buys);
    }
  }

  // Snapshot más reciente por instrumento. El port entrega la última fila
  // por `date`; si el caller pasara duplicados, gana la de mayor date (las
  // fechas YYYY-MM-DD comparan bien lexicográficamente).
  const latestSnapshotByInstrument = new Map<number, MarketdataSnapshot>();
  for (const snapshot of marketdataSnapshots) {
    const current = latestSnapshotByInstrument.get(snapshot.instrumentId);
    if (current === undefined || snapshot.date > current.date) {
      latestSnapshotByInstrument.set(snapshot.instrumentId, snapshot);
    }
  }

  const positions: PositionPnl[] = [];
  const instrumentIds = [...quantityByInstrument.keys()].sort((a, b) => a - b);

  for (const instrumentId of instrumentIds) {
    const quantityShares = quantityByInstrument.get(instrumentId) ?? 0;
    if (quantityShares === 0) continue; // posición cerrada: no se lista

    const buyMovements = buyMovementsByInstrument.get(instrumentId) ?? [];
    const weightedAverageCostArs = weightedAverageCost(buyMovements);

    const snapshot = latestSnapshotByInstrument.get(instrumentId);
    const priceAvailable = snapshot !== undefined;
    const marketValueArs = priceAvailable
      ? sizeAsDecimal(quantityShares).mul(snapshot.closeArs)
      : null;

    // Costo de la posición: quantity × costo promedio (negativo si la
    // posición es negativa). Costo 0 (sin compras) ⇒ retorno indefinido.
    const costBasisArs = sizeAsDecimal(quantityShares).mul(
      weightedAverageCostArs,
    );
    const totalReturnPctX100 =
      marketValueArs !== null && !costBasisArs.isZero()
        ? marketValueArs.minus(costBasisArs).div(costBasisArs).mul(HUNDRED)
        : null;

    positions.push({
      instrumentId,
      quantityShares,
      weightedAverageCostArs,
      marketValueArs,
      priceAvailable,
      totalReturnPctX100,
    });
  }

  return positions;
};