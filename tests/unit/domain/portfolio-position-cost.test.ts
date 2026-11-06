// P&L de POSICIÓN (F1): (a) el costo promedio ponderado es el de la posición
// VIVA — al llegar la cantidad neta a 0 el acumulado de costo y de acciones se
// reinicia, así una ida y vuelta no deja costo fantasma; (b) el retorno divide
// por |costBasis| (Q2=A firmado): una posición negativa que GANA da positivo y
// una que PIERDE, negativo. Nunca null por ser negativa.
//
// ASUNCIÓN DE ORDEN: los movimientos llegan en orden CRONOLÓGICO. El repo
// entrega los FILLED por id ASC (src/infra/prisma/portfolio-read-repository.ts)
// y los tests construyen la lista en ese orden: es el orden en el que se
// detecta el paso por cantidad 0.
//
// Dominio puro: sin DB, sin reloj, dinero en Decimal desde string.

import { FinancialDecimal } from "../../../src/contracts/index.js";
import {
  derivePositions,
  deriveTotalAccountValue,
  weightedAverageCost,
} from "../../../src/domain/portfolio/index.js";
import {
  SEED_INSTRUMENT_BMA_ID,
  SEED_INSTRUMENT_PAMP_ID,
} from "../../helpers/fixtures.js";
import {
  buildSnapshot,
  buildTradingMovement,
  positionOfInstrument,
} from "./helpers.js";

describe("weightedAverageCost — costo de la POSICIÓN VIVA", () => {
  it("ida y vuelta completa reinicia el acumulado: BUY 10@100, SELL 10@100, BUY 10@200 ⇒ 200, no 150", () => {
    const movements = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
    ];
    expect(weightedAverageCost(movements).toFixed(2)).toBe("200.00");
  });

  it("tras el reset promedia sólo las compras vivas: 10@200 y 10@300 ⇒ 250", () => {
    const movements = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "110.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "300.00" }),
    ];
    // (10×200 + 10×300) / 20 = 250; la compra a 100 quedó en la ida y vuelta.
    expect(weightedAverageCost(movements).toFixed(2)).toBe("250.00");
  });

  it("varios ciclos cerrados: sólo cuenta el último tramo abierto", () => {
    const movements = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "110.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "210.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 5, priceArs: "300.00" }),
    ];
    expect(weightedAverageCost(movements).toFixed(2)).toBe("300.00");
  });

  it("venta PARCIAL no reinicia ni toca el promedio", () => {
    const movements = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "260.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 30, priceArs: "240.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 25, priceArs: "240.00" }),
    ];
    // (2.600 + 7.200) / 40 = 245; quedan 15 acciones y el promedio no cambió.
    expect(weightedAverageCost(movements).toFixed(2)).toBe("245.00");
  });

  it("cerrar un corto con una compra también deja la posición plana: costo 0", () => {
    const movements = [
      buildTradingMovement({ side: "SELL", sizeShares: 5, priceArs: "100.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 5, priceArs: "120.00" }),
    ];
    expect(weightedAverageCost(movements).toFixed(2)).toBe("0.00");
  });

  it("CASH_IN/CASH_OUT intercalados no tocan el acumulado", () => {
    const movements = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      {
        side: "CASH_IN" as const,
        amountArs: new FinancialDecimal("1000.00"),
      },
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "100.00" }),
      {
        side: "CASH_OUT" as const,
        amountArs: new FinancialDecimal("1000.00"),
      },
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
    ];
    expect(weightedAverageCost(movements).toFixed(2)).toBe("200.00");
  });
});

describe("derivePositions — P&L de posición con reset y |costBasis|", () => {
  it("ciclo cerrado y reabierto: retorno económico 0% (no +33.33%)", () => {
    // BUY 10@100, SELL 10@100 (queda plano), BUY 10@200 con precio 200:
    // el costo de la posición viva es 2.000 y el mercado 2.000 ⇒ 0%.
    const movements = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
    ];
    const position = positionOfInstrument(
      derivePositions(movements, [buildSnapshot({ closeArs: "200.00" })]),
      SEED_INSTRUMENT_PAMP_ID,
    );

    expect(position.quantityShares).toBe(10n);
    expect(position.weightedAverageCostArs.toFixed(2)).toBe("200.00");
    expect(position.marketValueArs?.toFixed(2)).toBe("2000.00");
    expect(position.totalReturnPctX100?.toFixed(2)).toBe("0.00");
  });

  it("posición negativa que GANA ⇒ retorno POSITIVO", () => {
    // BUY 20@150, SELL 30@150, precio 135: corto de 10 con costo 1.500 que se
    // recompra a 1.350 ⇒ GANÓ 150 ⇒ +10%.
    const movements = [
      buildTradingMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "BUY",
        sizeShares: 20,
        priceArs: "150.00",
      }),
      buildTradingMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "SELL",
        sizeShares: 30,
        priceArs: "150.00",
      }),
    ];
    const position = positionOfInstrument(
      derivePositions(movements, [
        buildSnapshot({ instrumentId: SEED_INSTRUMENT_BMA_ID, closeArs: "135.00" }),
      ]),
      SEED_INSTRUMENT_BMA_ID,
    );

    expect(position.quantityShares).toBe(-10n);
    expect(position.marketValueArs?.toFixed(2)).toBe("-1350.00");
    expect(position.totalReturnPctX100?.toFixed(2)).toBe("10.00");
  });

  it("posición negativa que PIERDE ⇒ retorno NEGATIVO (nunca null)", () => {
    // Mismo corto con el precio subiendo a 165: recomprar cuesta 1.650 contra
    // un costo de 1.500 ⇒ PERDIÓ 150 ⇒ −10%.
    const movements = [
      buildTradingMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "BUY",
        sizeShares: 20,
        priceArs: "150.00",
      }),
      buildTradingMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "SELL",
        sizeShares: 30,
        priceArs: "150.00",
      }),
    ];
    const position = positionOfInstrument(
      derivePositions(movements, [
        buildSnapshot({ instrumentId: SEED_INSTRUMENT_BMA_ID, closeArs: "165.00" }),
      ]),
      SEED_INSTRUMENT_BMA_ID,
    );

    expect(position.quantityShares).toBe(-10n);
    expect(position.marketValueArs?.toFixed(2)).toBe("-1650.00");
    expect(position.totalReturnPctX100?.toFixed(2)).toBe("-10.00");
    expect(position.totalReturnPctX100).not.toBeNull();
  });

  it("el reset NO cambia quantityShares ni deriveTotalAccountValue", () => {
    // Escenario con ida y vuelta a precio plano: el cash liquidado es el
    // mismo que abrir directo a 200, así que el patrimonio total debe ser
    // idéntico. Sólo cambia el costo promedio (y con él el retorno).
    const cash = new FinancialDecimal("8000.00");
    const cycle = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "SELL", sizeShares: 10, priceArs: "100.00" }),
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
    ];
    const openedDirectly = [
      buildTradingMovement({ side: "BUY", sizeShares: 10, priceArs: "200.00" }),
    ];

    const cyclePositions = derivePositions(cycle, [
      buildSnapshot({ closeArs: "200.00" }),
    ]);
    const directPositions = derivePositions(openedDirectly, [
      buildSnapshot({ closeArs: "200.00" }),
    ]);

    const fromCycle = positionOfInstrument(cyclePositions, SEED_INSTRUMENT_PAMP_ID);
    const fromDirect = positionOfInstrument(directPositions, SEED_INSTRUMENT_PAMP_ID);

    // Cantidad y valor de mercado: iguales (el reset no toca acciones).
    expect(fromCycle.quantityShares).toBe(fromDirect.quantityShares);
    expect(fromCycle.marketValueArs?.toFixed(2)).toBe(
      fromDirect.marketValueArs?.toFixed(2),
    );
    // Patrimonio total: igual (el promedio no entra en la suma).
    expect(deriveTotalAccountValue(cash, cyclePositions).toFixed(2)).toBe("10000.00");
    expect(deriveTotalAccountValue(cash, cyclePositions).toFixed(2)).toBe(
      deriveTotalAccountValue(cash, directPositions).toFixed(2),
    );
    // Lo único que difiere es el costo promedio y, con él, el retorno.
    expect(fromCycle.weightedAverageCostArs.toFixed(2)).toBe("200.00");
    expect(fromDirect.weightedAverageCostArs.toFixed(2)).toBe("200.00");
    expect(fromCycle.totalReturnPctX100?.toFixed(2)).toBe(
      fromDirect.totalReturnPctX100?.toFixed(2),
    );
  });
});
