// Tests unitarios de deriveTotalAccountValue: patrimonio total = cash
// liquidado + Σ marketValue de las posiciones CON precio. Sin DB ni Express;
// dinero en Decimal desde string.

import { Decimal } from "decimal.js";
import type { PositionPnl } from "../../../src/contracts/index.js";
import { deriveTotalAccountValue } from "../../../src/domain/portfolio/index.js";
import { SEED_USER_1_PORTFOLIO } from "../../helpers/fixtures.js";

/** Posición mínima: sólo importa su marketValue (null = sin precio). */
const position = (marketValueArs: string | null): PositionPnl => ({
  instrumentId: 1,
  quantityShares: 10,
  weightedAverageCostArs: new Decimal("100.00"),
  marketValueArs: marketValueArs === null ? null : new Decimal(marketValueArs),
  priceAvailable: marketValueArs !== null,
  totalReturnPctX100: null,
});

describe("deriveTotalAccountValue — patrimonio de la cuenta", () => {
  it("sin posiciones ⇒ devuelve el cash liquidado", () => {
    expect(deriveTotalAccountValue(new Decimal("1000.00"), []).toFixed(2)).toBe(
      "1000.00",
    );
  });

  it("suma el marketValue de las posiciones con precio", () => {
    const total = deriveTotalAccountValue(new Decimal("1000.00"), [
      position("250.50"),
      position("100.25"),
    ]);
    expect(total.toFixed(2)).toBe("1350.75");
  });

  it("la posición sin precio no suma (sin fallback a costo)", () => {
    const total = deriveTotalAccountValue(new Decimal("1000.00"), [
      position("250.50"),
      position(null),
    ]);
    expect(total.toFixed(2)).toBe("1250.50");
  });

  it("la posición negativa resta", () => {
    const total = deriveTotalAccountValue(new Decimal("1000.00"), [
      position("250.50"),
      position("-400.00"),
    ]);
    expect(total.toFixed(2)).toBe("850.50");
  });

  it("reproduce el golden del seed: 753000 + 37034 + 114750 − 15028 = 889756", () => {
    const total = deriveTotalAccountValue(
      new Decimal(SEED_USER_1_PORTFOLIO.cashSettledArs),
      [position("37034.00"), position("114750.00"), position("-15028.00")],
    );
    expect(total.toFixed(2)).toBe("889756.00");
  });

  it("incluye el cash reservado: disponible + reservado + Σ marketValue da el mismo total", () => {
    const positions = [
      position("37034.00"),
      position("114750.00"),
      position("-15028.00"),
    ];
    const cashSettled = new Decimal(SEED_USER_1_PORTFOLIO.cashSettledArs);
    const cashReserved = new Decimal(SEED_USER_1_PORTFOLIO.cashReservedArs);
    const cashAvailable = cashSettled.minus(cashReserved);

    const fromSettled = deriveTotalAccountValue(cashSettled, positions);
    const fromAvailablePlusReserved = deriveTotalAccountValue(
      cashAvailable.plus(cashReserved),
      positions,
    );

    expect(fromSettled.toFixed(2)).toBe("889756.00");
    expect(fromAvailablePlusReserved.toFixed(2)).toBe("889756.00");
  });
});
