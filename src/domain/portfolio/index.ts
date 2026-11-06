// Dominio de portfolio: funciones PURAS de derivación.
// Sin Prisma, sin Express, sin I/O ni reloj: la única fuente de verdad es la
// lista de movimientos/órdenes que el llamador ya leyó (capa de aplicación,
// dentro de la misma tx de validación). Dinero SIEMPRE en el constructor
// financiero de contracts (AGENTS.md: nunca float).
//
// D2/D3 de specs/datos-financieros-grandes-montos.md: cash entra como monto
// exacto (CASH_IN/CASH_OUT.amountArs, con centavos), las cantidades
// agregadas y las reservas son bigint, y los productos/sumas se calculan en
// Decimal de 64 cifras: el máximo de una columna NO acota un agregado.
//
// Reglas en DECISIONS.md; proyección de orders en docs/database.md §3.

import { FinancialDecimal } from "../../contracts/index.js";
import type {
  MarketdataSnapshot,
  PositionPnl,
  Reservations,
  RestingOrder,
  SettledOrderMovement,
  TradingSettledOrderMovement,
} from "../../contracts/index.js";

/** 100, para el retorno porcentual — Decimal, nunca float. */
const HUNDRED = new FinancialDecimal("100");

/** Cantidad de acciones POR ORDEN (number, ≤ INT4) → Decimal sin float. */
const sizeAsDecimal = (sizeShares: number): FinancialDecimal =>
  new FinancialDecimal(String(sizeShares));

/** Cantidad AGREGADA (bigint) → Decimal desde string. */
const quantityAsDecimal = (quantityShares: bigint): FinancialDecimal =>
  new FinancialDecimal(quantityShares.toString());

/** Notional de un movimiento de trading: size × precio de ejecución (exacto). */
const notionalArs = (movement: TradingSettledOrderMovement): FinancialDecimal =>
  sizeAsDecimal(movement.sizeShares).mul(movement.priceArs);

/** ¿El movimiento movió acciones? (CASH_IN/CASH_OUT no forman posiciones). */
const isTradingMovement = (
  movement: SettledOrderMovement,
): movement is TradingSettledOrderMovement =>
  movement.side === "BUY" || movement.side === "SELL";

/**
 * Efecto de UN movimiento FILLED sobre el cash liquidado: CASH_IN/SELL suman,
 * CASH_OUT/BUY restan. El cash usa su monto exacto; el trading, size × precio.
 */
const cashDeltaArs = (movement: SettledOrderMovement): FinancialDecimal => {
  if (!isTradingMovement(movement)) {
    return movement.side === "CASH_OUT"
      ? movement.amountArs.neg()
      : movement.amountArs;
  }
  const notional = notionalArs(movement);
  return movement.side === "BUY" ? notional.neg() : notional;
};

/**
 * Cash liquidado (cashSettled) de los movimientos FILLED de un usuario:
 * Σ CASH_IN − CASH_OUT + SELL size×price − BUY size×price
 * (docs/database.md §3). 0 si no hay movimientos.
 *
 * PURA: no mira reservas (NEW no mueve plata — el cash disponible es
 * `deriveCash(...) − deriveReservations(...).cashReservedArs`, resta que
 * hace la capa de aplicación).
 */
export const deriveCash = (
  settledMovements: readonly SettledOrderMovement[],
): FinancialDecimal =>
  settledMovements.reduce<FinancialDecimal>(
    (cash, movement) => cash.plus(cashDeltaArs(movement)),
    new FinancialDecimal("0"),
  );

/**
 * Reservas derivadas de las órdenes NEW de un usuario (sin tabla —
 * DECISIONS.md): cada BUY reserva `limit × size` de cash; cada SELL reserva
 * `size` acciones de SU instrumento. El cash disponible es
 * `cashSettled − cashReservedArs` (CASH_OUT valida contra eso).
 *
 * Las acciones reservadas se acumulan en bigint: muchas órdenes válidas
 * (cada una ≤ INT4) pueden superar el entero seguro de JS.
 * Los BUY no reservan acciones ni crean entrada en el mapa: sólo los
 * instrumentos con SELL NEW aparecen. Sin órdenes ⇒ cash 0 y mapa vacío.
 */
export const deriveReservations = (
  restingOrders: readonly RestingOrder[],
): Reservations => {
  let cashReservedArs = new FinancialDecimal("0");
  const sharesReservedByInstrument = new Map<number, bigint>();

  for (const order of restingOrders) {
    if (order.side === "BUY") {
      cashReservedArs = cashReservedArs.plus(
        sizeAsDecimal(order.sizeShares).mul(order.limitPriceArs),
      );
    } else {
      const reserved = sharesReservedByInstrument.get(order.instrumentId) ?? 0n;
      sharesReservedByInstrument.set(
        order.instrumentId,
        reserved + BigInt(order.sizeShares),
      );
    }
  }

  return { cashReservedArs, sharesReservedByInstrument };
};

/**
 * Acumulado de la POSICIÓN VIVA de un instrumento: cantidad neta firmada y
 * las compras que la sostienen, contadas desde el último punto en que la
 * cantidad neta volvió a 0.
 */
interface LiveCost {
  readonly netShares: bigint;
  readonly boughtShares: bigint;
  readonly boughtCostArs: FinancialDecimal;
}

/** Posición plana: sin acciones netas ni costo acumulado. */
const FLAT_LIVE_COST: LiveCost = {
  netShares: 0n,
  boughtShares: 0n,
  boughtCostArs: new FinancialDecimal("0"),
};

/**
 * Aplica UN movimiento de trading al acumulado de la posición viva. BUY suma
 * acciones y costo; SELL resta acciones SIN tocar el promedio (DECISIONS.md).
 * Si la cantidad neta queda en 0 la posición se cerró: vuelve a FLAT y el
 * costo de la ida y vuelta ya realizada no contamina la posición que se
 * reabra después.
 */
const accumulateLiveCost = (
  live: LiveCost,
  movement: TradingSettledOrderMovement,
): LiveCost => {
  const signedShares = BigInt(movement.sizeShares);
  const isBuy = movement.side === "BUY";
  const netShares = live.netShares + (isBuy ? signedShares : -signedShares);

  if (netShares === 0n) return FLAT_LIVE_COST;
  if (!isBuy) return { ...live, netShares };

  return {
    netShares,
    boughtShares: live.boughtShares + signedShares,
    boughtCostArs: live.boughtCostArs.plus(notionalArs(movement)),
  };
};

/** Promedio vivo: Σ costo / Σ acciones compradas; 0 sin compras vivas. */
const averageCostOf = (live: LiveCost): FinancialDecimal =>
  live.boughtShares === 0n
    ? new FinancialDecimal("0")
    : live.boughtCostArs.div(quantityAsDecimal(live.boughtShares));

/**
 * Costo promedio ponderado de las compras de la POSICIÓN VIVA de UN
 * instrumento: Σ(size × price) / Σ size de las compras hechas desde que la
 * cantidad neta volvió a 0. Las ventas bajan la cantidad SIN tocar el
 * promedio (DECISIONS.md: P&L no realizado sobre costo promedio ponderado),
 * pero una posición cerrada reinicia el acumulado: BUY 10@100, SELL 10@100,
 * BUY 10@200 ⇒ 200, no 150. 0 si no hay compras vivas (posición heredada sin
 * buys).
 *
 * ASUNCIÓN DE ORDEN: los movimientos llegan en orden CRONOLÓGICO — el repo
 * entrega los FILLED por id ASC (portfolio-read-repository.ts). Ese orden es
 * el que permite detectar el paso por cantidad 0.
 *
 * El llamador agrupa por instrumento antes de llamar (no hay filtrado
 * acá): la agrupación es de la capa de aplicación o de derivePositions.
 */
export const weightedAverageCost = (
  movements: readonly SettledOrderMovement[],
): FinancialDecimal =>
  averageCostOf(
    movements.filter(isTradingMovement).reduce(accumulateLiveCost, FLAT_LIVE_COST),
  );

/**
 * Acumula UN movimiento de trading en su instrumento: cantidad firmada
 * (BUY suma, SELL resta) y costo de la posición viva (con reset al quedar
 * en 0). Muta el mapa de trabajo privado de la derivación.
 */
const addTradingMovement = (
  liveByInstrument: Map<number, LiveCost>,
  movement: TradingSettledOrderMovement,
): void => {
  const live = liveByInstrument.get(movement.instrumentId) ?? FLAT_LIVE_COST;
  liveByInstrument.set(
    movement.instrumentId,
    accumulateLiveCost(live, movement),
  );
};

/** Agrupa los movimientos FILLED por instrumento (ignora CASH_IN/CASH_OUT). */
const groupTradingActivity = (
  settledMovements: readonly SettledOrderMovement[],
): ReadonlyMap<number, LiveCost> => {
  const liveByInstrument = new Map<number, LiveCost>();
  for (const movement of settledMovements) {
    if (!isTradingMovement(movement)) continue;
    addTradingMovement(liveByInstrument, movement);
  }
  return liveByInstrument;
};

/**
 * Snapshot más reciente por instrumento. El port entrega la última fila
 * por `date`; si el caller pasara duplicados, gana la de mayor date (las
 * fechas YYYY-MM-DD comparan bien lexicográficamente) y, a igual fecha,
 * queda la primera leída.
 */
const latestSnapshotPerInstrument = (
  marketdataSnapshots: readonly MarketdataSnapshot[],
): ReadonlyMap<number, MarketdataSnapshot> => {
  const latestByInstrument = new Map<number, MarketdataSnapshot>();
  for (const snapshot of marketdataSnapshots) {
    const current = latestByInstrument.get(snapshot.instrumentId);
    if (current === undefined || snapshot.date > current.date) {
      latestByInstrument.set(snapshot.instrumentId, snapshot);
    }
  }
  return latestByInstrument;
};

/**
 * Posición con P&L no realizado de UN instrumento. `snapshot` undefined
 * significa sin precio (NO_PRICE): marketValue y totalReturn null, y la
 * posición no suma al total. Costo 0 (sin compras) ⇒ retorno indefinido.
 *
 * RETORNO CON DENOMINADOR |costBasis| (Q2=A firmado): el costo de una
 * posición negativa es negativo, y dividir por él invertiría el signo. Con
 * |costBasis| el signo lo da el P&L económico: gana ⇒ positivo, pierde ⇒
 * negativo, nunca null por ser negativa.
 */
const toPositionPnl = (
  instrumentId: number,
  live: LiveCost,
  snapshot: MarketdataSnapshot | undefined,
): PositionPnl => {
  const quantityShares = live.netShares;
  const weightedAverageCostArs = averageCostOf(live);
  const quantityAsDec = quantityAsDecimal(quantityShares);
  const marketValueArs =
    snapshot === undefined ? null : quantityAsDec.mul(snapshot.closeArs);

  // Costo de la posición: quantity × costo promedio (negativo si la
  // posición es negativa). El retorno divide por su VALOR ABSOLUTO.
  const costBasisArs = quantityAsDec.mul(weightedAverageCostArs);
  const returnDenominatorArs = costBasisArs.abs();
  const totalReturnPctX100 =
    marketValueArs !== null && !returnDenominatorArs.isZero()
      ? marketValueArs.minus(costBasisArs).div(returnDenominatorArs).mul(HUNDRED)
      : null;

  return {
    instrumentId,
    quantityShares,
    weightedAverageCostArs,
    marketValueArs,
    priceAvailable: snapshot !== undefined,
    totalReturnPctX100,
  };
};

/**
 * Posiciones con P&L no realizado de un usuario a partir de sus movimientos
 * FILLED de trading y los precios de referencia disponibles.
 *
 * Reglas (DECISIONS.md):
 *  - sólo BUY/SELL son posiciones (CASH_IN/CASH_OUT se ignoran ANTES de
 *    tocar campos de acciones: su unidad es un monto);
 *  - quantity = Σ size BUY − Σ size SELL, por instrumento, en bigint;
 *  - posición con cantidad 0 NO se lista;
 *  - posición negativa (BMA −10 del seed) se devuelve tal cual;
 *  - costo promedio ponderado de la POSICIÓN VIVA: las ventas no lo tocan y
 *    una posición cerrada (cantidad neta 0) lo reinicia;
 *  - sin snapshot de marketdata: marketValueArs null, priceAvailable false,
 *    totalReturnPctX100 null (la posición no suma al total, arriba);
 *  - costo 0 (posición sin compras): totalReturnPctX100 null;
 *  - retorno sobre |costBasis|: una posición negativa que gana da positivo.
 *
 * ASUNCIÓN DE ORDEN: los movimientos llegan en orden CRONOLÓGICO (el repo
 * entrega los FILLED por id ASC). El reset del costo al quedar plano depende
 * de ese orden.
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
  const liveByInstrument = groupTradingActivity(settledMovements);
  const latestSnapshotByInstrument =
    latestSnapshotPerInstrument(marketdataSnapshots);

  return [...liveByInstrument.entries()]
    .filter(([, live]) => live.netShares !== 0n) // cerrada: no se lista
    .sort(([leftId], [rightId]) => leftId - rightId)
    .map(([instrumentId, live]) =>
      toPositionPnl(
        instrumentId,
        live,
        latestSnapshotByInstrument.get(instrumentId),
      ),
    );
};

/**
 * Patrimonio total de la cuenta: cash liquidado + Σ marketValue de las
 * posiciones CON precio. Equivale a cash disponible + cash reservado + Σ
 * marketValue, así que abrir o cancelar una orden NEW no lo mueve (reservar
 * cash no saca patrimonio). Las posiciones sin precio no suman; las
 * negativas restan. El agregado puede superar el máximo de una fila.
 *
 * PURA: no mira reservas — recibe el cash liquidado, no el disponible.
 */
export const deriveTotalAccountValue = (
  cashSettledArs: FinancialDecimal,
  positions: readonly PositionPnl[],
): FinancialDecimal =>
  positions.reduce<FinancialDecimal>(
    (total, position) =>
      position.marketValueArs === null
        ? total
        : total.plus(position.marketValueArs),
    cashSettledArs,
  );
