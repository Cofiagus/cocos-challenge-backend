// Caso de uso GET /api/users/:userId/portfolio (UC-1).
//
// Orquesta los puertos de lectura y las funciones PURAS de src/domain:
// userExists resuelve el 404, deriveCash/deriveReservations/derivePositions
// arman el estado y el catálogo de instrumentos aporta ticker/name. No hay
// Express ni serialización acá: el borde HTTP traduce este resultado.
//
// DECISIONS.md:
//  - cash disponible = cashSettled − cashReserved (deriveCash NO mira
//    reservas; la resta es de esta capa);
//  - sin precio de referencia (NO_PRICE): marketValue null,
//    priceAvailable false, totalReturnPct null y la posición NO suma al
//    totalAccountValue (las negativas SÍ restan);
//  - posición con cantidad 0 no se lista (la oculta derivePositions);
//  - MONEDA nunca llega: no es posición derivable de BUY/SELL.

import type { Decimal } from "decimal.js";
import type {
  InstrumentRecord,
  PositionPnl,
  SettledOrderMovement,
} from "../../contracts/index.js";
import {
  deriveCash,
  derivePositions,
  deriveReservations,
} from "../../domain/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";

/** Puertos que el caso de uso consume (interfaces, nunca implementaciones). */
export interface GetPortfolioDeps {
  /** Lado de lectura del portfolio (userExists resuelve el 404). */
  readonly portfolioRead: PortfolioReadRepository;
  /** Precios de referencia: UN batch de snapshots (getLatestSnapshots). */
  readonly marketdata: MarketdataRepository;
  /** ticker/name de cada posición derivada, en UN batch (findByIds). */
  readonly instruments: InstrumentRepository;
}

/** Posición con el catálogo resuelto y el dinero todavía en Decimal. */
export interface PortfolioPositionView {
  readonly ticker: string;
  readonly name: string;
  readonly quantityShares: number;
  readonly marketValueArs: Decimal | null;
  readonly priceAvailable: boolean;
  readonly totalReturnPctX100: Decimal | null;
}

/** Portfolio en valores de dominio: el borde lo serializa al contrato. */
export interface PortfolioState {
  /** cashSettled − cashReserved. */
  readonly cashArs: Decimal;
  /** Σ limit × size de las BUY NEW. */
  readonly reservedCashArs: Decimal;
  /** cash disponible + Σ marketValue de las posiciones CON precio. */
  readonly totalAccountValueArs: Decimal;
  readonly positions: readonly PortfolioPositionView[];
}

/** Usuario inexistente o portfolio derivado; el borde mapea el 404. */
export type GetPortfolioResult =
  | { readonly kind: "USER_NOT_FOUND" }
  | { readonly kind: "FOUND"; readonly portfolio: PortfolioState };

/** ¿El side mueve acciones? (CASH_IN/CASH_OUT no son posiciones). */
const isTradingMovement = (movement: SettledOrderMovement): boolean =>
  movement.side === "BUY" || movement.side === "SELL";

/**
 * Instrumentos que PUEDEN tener posición (BUY/SELL FILLED), sin duplicados:
 * CASH_IN/CASH_OUT quedan fuera del batch de snapshots.
 */
const tradedInstrumentIds = (
  movements: readonly SettledOrderMovement[],
): readonly number[] => [
  ...new Set(
    movements
      .filter(isTradingMovement)
      .map((movement) => movement.instrumentId),
  ),
];

/** Índice id → instrumento: resuelve ticker/name sin N+1. */
const indexInstrumentsById = (
  instruments: readonly InstrumentRecord[],
): ReadonlyMap<number, InstrumentRecord> =>
  new Map(
    instruments.map((instrument) => [instrument.id, instrument] as const),
  );

/**
 * Posición lista para el contrato, con ticker/name del catálogo.
 * Instrumento ausente = orden FILLED huérfana: corrupción de datos, falla
 * ruidosa; nunca se omite en silencio.
 */
const toPositionView = (
  position: PositionPnl,
  instrumentsById: ReadonlyMap<number, InstrumentRecord>,
): PortfolioPositionView => {
  const instrument = instrumentsById.get(position.instrumentId);
  if (instrument === undefined) {
    throw new Error(
      `Instrumento ${position.instrumentId} de la posición no existe (orden huérfana).`,
    );
  }
  return {
    ticker: instrument.ticker,
    name: instrument.name,
    quantityShares: position.quantityShares,
    marketValueArs: position.marketValueArs,
    priceAvailable: position.priceAvailable,
    totalReturnPctX100: position.totalReturnPctX100,
  };
};

/**
 * totalAccountValue = cash disponible + Σ marketValue de las posiciones CON
 * precio (las null NO suman; las negativas SÍ restan — BMA del seed).
 */
const totalAccountValue = (
  cashArs: Decimal,
  positions: readonly PositionPnl[],
): Decimal =>
  positions.reduce<Decimal>(
    (total, position) =>
      position.marketValueArs === null
        ? total
        : total.plus(position.marketValueArs),
    cashArs,
  );

/**
 * Deriva el portfolio de un usuario. Devuelve valores de dominio; el borde
 * decide el status HTTP (404 USER_NOT_FOUND / 200 FOUND).
 */
export const getPortfolio = async (
  deps: GetPortfolioDeps,
  userId: number,
): Promise<GetPortfolioResult> => {
  // 404 de usuario inexistente (userExists del port de lectura).
  const userExists = await deps.portfolioRead.userExists(userId);
  if (!userExists) return { kind: "USER_NOT_FOUND" };

  // Lecturas del port: movimientos FILLED y órdenes NEW (reservas).
  // Secuenciales (no Promise.all): Prisma no documenta queries paralelas
  // sobre una misma sesión/tx interactiva, y dos SELECT no ganan nada
  // medible en paralelo.
  // Eventual consistency aceptable: son queries INDEPENDIENTES — un
  // submit que comitee entre ambas produce un snapshot no puntual
  // (cash descontado sin su reserva). Este endpoint es informativo; los
  // writes se validan dentro de withUserTransaction (lock por usuario),
  // así que esto NO habilita double-spend. No se envuelven en una tx
  // (cambiaría el comportamiento de lectura).
  const movements = await deps.portfolioRead.listSettledMovements(userId);
  const restingOrders = await deps.portfolioRead.listRestingOrders(userId);

  // UN batch de snapshots de los instrumentos que PUEDEN tener posición.
  const snapshots = await deps.marketdata.getLatestSnapshots(
    tradedInstrumentIds(movements),
  );

  const cashSettled = deriveCash(movements);
  const reservations = deriveReservations(restingOrders);
  const positions = derivePositions(movements, snapshots);

  // UN batch de instrumentos (una consulta IN para todas las posiciones).
  const instruments = await deps.instruments.findByIds(
    positions.map((position) => position.instrumentId),
  );
  const instrumentsById = indexInstrumentsById(instruments);

  // Cash disponible = cashSettled − cashReserved (DECISIONS.md).
  const cashArs = cashSettled.minus(reservations.cashReservedArs);

  return {
    kind: "FOUND",
    portfolio: {
      cashArs,
      reservedCashArs: reservations.cashReservedArs,
      totalAccountValueArs: totalAccountValue(cashArs, positions),
      positions: positions.map((position) =>
        toPositionView(position, instrumentsById),
      ),
    },
  };
};
