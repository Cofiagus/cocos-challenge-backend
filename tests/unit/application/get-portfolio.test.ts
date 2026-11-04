// Tests unitarios del caso de uso getPortfolio: puertos FALSOS en memoria,
// sin DB ni Express. Cubren el 404, el cash, las posiciones (con precio, sin
// precio y negativa), el instrumento huérfano y el fan-out de instrumentos
// (un único findByIds, ningún findById).

import { Decimal } from "decimal.js";
import { getPortfolio } from "../../../src/application/portfolio/get-portfolio.js";
import type {
  GetPortfolioResult,
  PortfolioPositionView,
  PortfolioState,
} from "../../../src/application/portfolio/get-portfolio.js";
import type {
  InstrumentRecord,
  MarketdataSnapshot,
  RestingOrder,
  SettledOrderMovement,
} from "../../../src/contracts/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  PortfolioReadRepository,
} from "../../../src/domain/ports/index.js";

// ---------------------------------------------------------------------------
// Builders de insumos (dinero desde string, nunca float)
// ---------------------------------------------------------------------------

interface MovementSeed {
  readonly instrumentId?: number;
  readonly side: SettledOrderMovement["side"];
  readonly sizeShares: number;
  readonly priceArs: string;
}

const movement = (seed: MovementSeed): SettledOrderMovement => ({
  instrumentId: seed.instrumentId ?? 1,
  side: seed.side,
  sizeShares: seed.sizeShares,
  priceArs: new Decimal(seed.priceArs),
});

interface RestingOrderSeed {
  readonly id?: number;
  readonly instrumentId?: number;
  readonly side?: RestingOrder["side"];
  readonly sizeShares: number;
  readonly limitPriceArs: string;
}

const restingOrder = (seed: RestingOrderSeed): RestingOrder => ({
  id: seed.id ?? 1,
  instrumentId: seed.instrumentId ?? 1,
  side: seed.side ?? "BUY",
  sizeShares: seed.sizeShares,
  limitPriceArs: new Decimal(seed.limitPriceArs),
});

interface SnapshotSeed {
  readonly instrumentId: number;
  readonly closeArs: string;
}

const snapshot = (seed: SnapshotSeed): MarketdataSnapshot => ({
  instrumentId: seed.instrumentId,
  date: "2023-07-14",
  closeArs: new Decimal(seed.closeArs),
  previousCloseArs: new Decimal(seed.closeArs),
});

const instrument = (
  id: number,
  ticker: string,
  name: string,
): InstrumentRecord => ({ id, ticker, name, type: "ACCIONES" });

// ---------------------------------------------------------------------------
// Puertos falsos
// ---------------------------------------------------------------------------

interface PortfolioReadSeed {
  readonly userExists?: boolean;
  readonly movements?: readonly SettledOrderMovement[];
  readonly restingOrders?: readonly RestingOrder[];
}

const buildPortfolioRead = (
  seed: PortfolioReadSeed,
): PortfolioReadRepository => ({
  userExists: async () => seed.userExists ?? true,
  listSettledMovements: async () => seed.movements ?? [],
  listRestingOrders: async () => seed.restingOrders ?? [],
});

const buildMarketdata = (
  snapshots: readonly MarketdataSnapshot[],
): MarketdataRepository => ({
  getLatestSnapshot: async (instrumentId) =>
    snapshots.find((row) => row.instrumentId === instrumentId) ?? null,
  getLatestSnapshots: async (instrumentIds) =>
    snapshots.filter((row) => instrumentIds.includes(row.instrumentId)),
});

interface InstrumentCatalog {
  readonly repository: InstrumentRepository;
  /** Ids pedidos en cada llamada a findByIds (una sola esperada). */
  readonly findByIdsCalls: readonly (readonly number[])[];
  /** Ids pedidos a findById (ninguno esperado: el caso de uso no lo usa). */
  readonly findByIdCalls: readonly number[];
}

const buildInstrumentCatalog = (
  records: readonly InstrumentRecord[],
): InstrumentCatalog => {
  const findByIdsCalls: (readonly number[])[] = [];
  const findByIdCalls: number[] = [];
  const repository: InstrumentRepository = {
    findById: async (instrumentId) => {
      findByIdCalls.push(instrumentId);
      return records.find((record) => record.id === instrumentId) ?? null;
    },
    findByIds: async (instrumentIds) => {
      findByIdsCalls.push(instrumentIds);
      return records.filter((record) => instrumentIds.includes(record.id));
    },
    findByTicker: async () => null,
    searchByQuery: async () => [],
  };
  return { repository, findByIdsCalls, findByIdCalls };
};

// ---------------------------------------------------------------------------
// Lectura del resultado (sin `!`: el test falla con un mensaje claro)
// ---------------------------------------------------------------------------

const foundPortfolio = (result: GetPortfolioResult): PortfolioState => {
  if (result.kind !== "FOUND") {
    throw new Error("Se esperaba un portfolio FOUND.");
  }
  return result.portfolio;
};

const positionAt = (
  positions: readonly PortfolioPositionView[],
  index: number,
): PortfolioPositionView => {
  const position = positions[index];
  if (position === undefined) {
    throw new Error(`Falta la posición ${index} en el resultado.`);
  }
  return position;
};

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

describe("getPortfolio — caso de uso de GET /portfolio", () => {
  it("usuario inexistente ⇒ USER_NOT_FOUND sin consultar instrumentos", async () => {
    const instruments = buildInstrumentCatalog([]);

    const result = await getPortfolio(
      {
        portfolioRead: buildPortfolioRead({ userExists: false }),
        marketdata: buildMarketdata([]),
        instruments: instruments.repository,
      },
      999_999,
    );

    expect(result).toEqual({ kind: "USER_NOT_FOUND" });
    expect(instruments.findByIdsCalls).toHaveLength(0);
  });

  it("sólo cash ⇒ disponible = cashSettled, sin reservas ni posiciones", async () => {
    const instruments = buildInstrumentCatalog([]);

    const result = await getPortfolio(
      {
        portfolioRead: buildPortfolioRead({
          movements: [
            movement({
              instrumentId: 66,
              side: "CASH_IN",
              sizeShares: 100_000,
              priceArs: "1.00",
            }),
          ],
        }),
        marketdata: buildMarketdata([]),
        instruments: instruments.repository,
      },
      1,
    );

    const portfolio = foundPortfolio(result);
    expect(portfolio.cashArs.toFixed(2)).toBe("100000.00");
    expect(portfolio.reservedCashArs.toFixed(2)).toBe("0.00");
    expect(portfolio.totalAccountValueArs.toFixed(2)).toBe("100000.00");
    expect(portfolio.positions).toEqual([]);
    // CASH_IN no es posición: no hay instrumentos que resolver.
    expect(instruments.findByIdsCalls).toEqual([[]]);
  });

  it("posiciones con precio ⇒ marketValue y total = cash + Σ marketValue", async () => {
    const instruments = buildInstrumentCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "METR", "MetroGAS S.A."),
    ]);

    const result = await getPortfolio(
      {
        portfolioRead: buildPortfolioRead({
          movements: [
            movement({
              instrumentId: 66,
              side: "CASH_IN",
              sizeShares: 100_000,
              priceArs: "1.00",
            }),
            movement({
              instrumentId: 1,
              side: "BUY",
              sizeShares: 10,
              priceArs: "900.00",
            }),
            movement({
              instrumentId: 2,
              side: "BUY",
              sizeShares: 5,
              priceArs: "200.00",
            }),
          ],
        }),
        marketdata: buildMarketdata([
          snapshot({ instrumentId: 1, closeArs: "1000.00" }),
          snapshot({ instrumentId: 2, closeArs: "300.00" }),
        ]),
        instruments: instruments.repository,
      },
      1,
    );

    const portfolio = foundPortfolio(result);
    // 100000 − 9000 − 1000 = 90000; total = 90000 + 10000 + 1500.
    expect(portfolio.cashArs.toFixed(2)).toBe("90000.00");
    expect(portfolio.totalAccountValueArs.toFixed(2)).toBe("101500.00");
    expect(portfolio.positions).toHaveLength(2);

    const pamp = positionAt(portfolio.positions, 0);
    expect(pamp.ticker).toBe("PAMP");
    expect(pamp.name).toBe("Pampa Holding S.A.");
    expect(pamp.quantityShares).toBe(10);
    expect(pamp.marketValueArs?.toFixed(2)).toBe("10000.00");
    expect(pamp.priceAvailable).toBe(true);
    // (10000 − 9000) / 9000 × 100 = 11.11 %.
    expect(pamp.totalReturnPctX100?.toFixed(2)).toBe("11.11");

    const metr = positionAt(portfolio.positions, 1);
    expect(metr.ticker).toBe("METR");
    expect(metr.quantityShares).toBe(5);
    expect(metr.marketValueArs?.toFixed(2)).toBe("1500.00");
    // (1500 − 1000) / 1000 × 100 = 50 %.
    expect(metr.totalReturnPctX100?.toFixed(2)).toBe("50.00");
  });

  it("posición sin precio ⇒ marketValue null y NO suma al total", async () => {
    const instruments = buildInstrumentCatalog([
      instrument(1, "PGR", "Phoenix Global Resources"),
    ]);

    const result = await getPortfolio(
      {
        portfolioRead: buildPortfolioRead({
          movements: [
            movement({
              instrumentId: 66,
              side: "CASH_IN",
              sizeShares: 100_000,
              priceArs: "1.00",
            }),
            movement({
              instrumentId: 1,
              side: "BUY",
              sizeShares: 10,
              priceArs: "900.00",
            }),
          ],
        }),
        marketdata: buildMarketdata([]),
        instruments: instruments.repository,
      },
      1,
    );

    const portfolio = foundPortfolio(result);
    expect(portfolio.cashArs.toFixed(2)).toBe("91000.00");
    expect(portfolio.totalAccountValueArs.toFixed(2)).toBe("91000.00");

    const position = positionAt(portfolio.positions, 0);
    expect(position.ticker).toBe("PGR");
    expect(position.quantityShares).toBe(10);
    expect(position.marketValueArs).toBeNull();
    expect(position.priceAvailable).toBe(false);
    expect(position.totalReturnPctX100).toBeNull();
  });

  it("posición negativa ⇒ su marketValue resta al total", async () => {
    const instruments = buildInstrumentCatalog([
      instrument(1, "BMA", "Banco Macro S.A."),
    ]);

    const result = await getPortfolio(
      {
        portfolioRead: buildPortfolioRead({
          movements: [
            movement({
              instrumentId: 66,
              side: "CASH_IN",
              sizeShares: 100_000,
              priceArs: "1.00",
            }),
            movement({
              instrumentId: 1,
              side: "BUY",
              sizeShares: 20,
              priceArs: "1000.00",
            }),
            movement({
              instrumentId: 1,
              side: "SELL",
              sizeShares: 30,
              priceArs: "1100.00",
            }),
          ],
        }),
        marketdata: buildMarketdata([
          snapshot({ instrumentId: 1, closeArs: "1000.00" }),
        ]),
        instruments: instruments.repository,
      },
      1,
    );

    const portfolio = foundPortfolio(result);
    // 100000 − 20000 + 33000 = 113000; total = 113000 − 10000.
    expect(portfolio.cashArs.toFixed(2)).toBe("113000.00");
    expect(portfolio.totalAccountValueArs.toFixed(2)).toBe("103000.00");

    const position = positionAt(portfolio.positions, 0);
    expect(position.quantityShares).toBe(-10);
    expect(position.marketValueArs?.toFixed(2)).toBe("-10000.00");
  });

  it("instrumento huérfano ⇒ lanza el error ruidoso con el id de la posición", async () => {
    const instruments = buildInstrumentCatalog([]);

    await expect(
      getPortfolio(
        {
          portfolioRead: buildPortfolioRead({
            movements: [
              movement({
                instrumentId: 99,
                side: "BUY",
                sizeShares: 1,
                priceArs: "10.00",
              }),
            ],
          }),
          marketdata: buildMarketdata([]),
          instruments: instruments.repository,
        },
        1,
      ),
    ).rejects.toThrow(
      "Instrumento 99 de la posición no existe (orden huérfana).",
    );
  });

  it("abrir una orden (reservar cash) no cambia totalAccountValue", async () => {
    const instruments = buildInstrumentCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
    ]);
    const movements = [
      movement({
        instrumentId: 66,
        side: "CASH_IN",
        sizeShares: 100_000,
        priceArs: "1.00",
      }),
      movement({
        instrumentId: 1,
        side: "BUY",
        sizeShares: 10,
        priceArs: "900.00",
      }),
    ];
    const marketdata = buildMarketdata([
      snapshot({ instrumentId: 1, closeArs: "1000.00" }),
    ]);

    const withoutOrder = foundPortfolio(
      await getPortfolio(
        {
          portfolioRead: buildPortfolioRead({ movements }),
          marketdata,
          instruments: instruments.repository,
        },
        1,
      ),
    );
    const withOrder = foundPortfolio(
      await getPortfolio(
        {
          portfolioRead: buildPortfolioRead({
            movements,
            restingOrders: [
              restingOrder({ sizeShares: 5, limitPriceArs: "500.00" }),
            ],
          }),
          marketdata,
          instruments: instruments.repository,
        },
        1,
      ),
    );

    // cash 91000 → 88500 y reservado 0 → 2500: el patrimonio no se mueve.
    expect(withoutOrder.cashArs.toFixed(2)).toBe("91000.00");
    expect(withoutOrder.reservedCashArs.toFixed(2)).toBe("0.00");
    expect(withoutOrder.totalAccountValueArs.toFixed(2)).toBe("101000.00");
    expect(withOrder.cashArs.toFixed(2)).toBe("88500.00");
    expect(withOrder.reservedCashArs.toFixed(2)).toBe("2500.00");
    expect(withOrder.totalAccountValueArs.toFixed(2)).toBe("101000.00");
  });

  it("resuelve el catálogo con UN findByIds y ningún findById", async () => {
    const instruments = buildInstrumentCatalog([
      instrument(1, "PAMP", "Pampa Holding S.A."),
      instrument(2, "METR", "MetroGAS S.A."),
      instrument(3, "BMA", "Banco Macro S.A."),
    ]);

    await getPortfolio(
      {
        portfolioRead: buildPortfolioRead({
          movements: [
            movement({
              instrumentId: 1,
              side: "BUY",
              sizeShares: 1,
              priceArs: "10.00",
            }),
            movement({
              instrumentId: 2,
              side: "BUY",
              sizeShares: 1,
              priceArs: "10.00",
            }),
            movement({
              instrumentId: 3,
              side: "BUY",
              sizeShares: 1,
              priceArs: "10.00",
            }),
          ],
        }),
        marketdata: buildMarketdata([]),
        instruments: instruments.repository,
      },
      1,
    );

    expect(instruments.findByIdsCalls).toEqual([[1, 2, 3]]);
    expect(instruments.findByIdCalls).toHaveLength(0);
  });
});
