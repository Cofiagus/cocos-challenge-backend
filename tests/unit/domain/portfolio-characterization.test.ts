// Caracterización de `derivePositions` (dominio puro, sin DB): fija el
// comportamiento observado ANTES de partir la función, con los casos de
// borde que el refactor no puede cambiar:
//  - snapshot duplicado con la MISMA fecha: gana el primero (comparación
//    estricta por `date`);
//  - posición negativa sin snapshot;
//  - cantidad 0 omitida de la lista;
//  - orden ascendente por instrumentId;
//  - venta sin compras previas (costo 0, retorno indefinido).

import { derivePositions } from "../../../src/domain/portfolio/index.js";
import {
  SEED_INSTRUMENT_BMA_ID,
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
} from "../../helpers/fixtures.js";
import {
  buildMovement,
  buildSnapshot,
  positionOfInstrument,
} from "./helpers.js";

describe("derivePositions — caracterización", () => {
  it("snapshot duplicado con la misma fecha: conserva el PRIMERO (date estricto)", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "BUY",
        sizeShares: 10,
        priceArs: "100.00",
      }),
    ];
    const snapshots = [
      buildSnapshot({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        date: "2023-07-14",
        closeArs: "100.00",
      }),
      buildSnapshot({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        date: "2023-07-14",
        closeArs: "999.00",
      }),
    ];

    const position = positionOfInstrument(
      derivePositions(movements, snapshots),
      SEED_INSTRUMENT_PAMP_ID,
    );
    // 10 × 100 (el primero), no 10 × 999.
    expect(position.marketValueArs?.toFixed(2)).toBe("1000.00");
  });

  it("posición negativa SIN snapshot: se lista tal cual, sin precio ni retorno", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "BUY",
        sizeShares: 20,
        priceArs: "150.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "SELL",
        sizeShares: 30,
        priceArs: "148.00",
      }),
    ];

    const position = positionOfInstrument(
      derivePositions(movements, []),
      SEED_INSTRUMENT_BMA_ID,
    );
    expect(position.quantityShares).toBe(-10);
    expect(position.weightedAverageCostArs.toFixed(2)).toBe("150.00");
    expect(position.marketValueArs).toBeNull();
    expect(position.priceAvailable).toBe(false);
    expect(position.totalReturnPctX100).toBeNull();
  });

  it("cantidad 0 se omite: no aparece la posición cerrada, sí la que queda abierta", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "BUY",
        sizeShares: 10,
        priceArs: "100.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "SELL",
        sizeShares: 10,
        priceArs: "101.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_METR_ID,
        side: "BUY",
        sizeShares: 5,
        priceArs: "250.00",
      }),
    ];

    const positions = derivePositions(movements, []);
    expect(positions.map((position) => position.instrumentId)).toEqual([
      SEED_INSTRUMENT_METR_ID,
    ]);
  });

  it("ordena ASCENDENTE por instrumentId aunque las filas vengan desordenadas", () => {
    const movements = [
      buildMovement({ instrumentId: 54, side: "BUY", sizeShares: 1, priceArs: "1.00" }),
      buildMovement({ instrumentId: SEED_INSTRUMENT_PAMP_ID, side: "BUY", sizeShares: 1, priceArs: "1.00" }),
      buildMovement({ instrumentId: SEED_INSTRUMENT_BMA_ID, side: "BUY", sizeShares: 1, priceArs: "1.00" }),
      buildMovement({ instrumentId: 54, side: "BUY", sizeShares: 2, priceArs: "1.00" }),
    ];

    expect(
      derivePositions(movements, []).map((position) => position.instrumentId),
    ).toEqual([SEED_INSTRUMENT_BMA_ID, SEED_INSTRUMENT_PAMP_ID, 54]);
  });

  it("venta sin compras previas: cantidad negativa, costo 0 y retorno indefinido", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "SELL",
        sizeShares: 5,
        priceArs: "100.00",
      }),
    ];

    const position = positionOfInstrument(
      derivePositions(movements, [
        buildSnapshot({
          instrumentId: SEED_INSTRUMENT_PAMP_ID,
          closeArs: "50.00",
        }),
      ]),
      SEED_INSTRUMENT_PAMP_ID,
    );
    expect(position.quantityShares).toBe(-5);
    expect(position.weightedAverageCostArs.toFixed(2)).toBe("0.00");
    expect(position.marketValueArs?.toFixed(2)).toBe("-250.00");
    expect(position.totalReturnPctX100).toBeNull();
  });
});
