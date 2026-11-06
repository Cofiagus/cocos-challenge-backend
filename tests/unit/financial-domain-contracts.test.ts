// T3/T10/T11a — contratos de dominio con unidades separadas (D2/D3 de
// specs/datos-financieros-grandes-montos.md):
//  - `SettledOrderMovement`, `OrderRecord` y `OrderDraft` son uniones
//    discriminadas por `side`: acciones (number, INT4) en BUY/SELL, monto
//    exacto (FinancialDecimal) en CASH_IN/CASH_OUT. El compilador impide usar
//    un monto como `sizeShares` (y viceversa).
//  - cantidades agregadas/reservas son bigint; `Portfolio.quantity` viaja como
//    string entero canónico (nunca BigInt crudo en JSON).
//  - `OrderResponse.size` discrimina por side: number|null en trading, string
//    monetario de 2 decimales en cash.
//
// Los fixtures usan `satisfies` para que un cambio de unidad rompa acá, no en
// producción. Las aserciones de tipo (`... extends keyof ... ? false : true`)
// fallan en typecheck si un campo prohibido aparece en la rama equivocada.

import {
  type CashOrderDraft,
  type CashOrderRecord,
  type CashSettledOrderMovement,
  type OrderDraft,
  type OrderRecord,
  type PositionPnl,
  type Reservations,
  type SettledOrderMovement,
  type TradingOrderDraft,
  type TradingOrderRecord,
  type TradingSettledOrderMovement,
} from "../../src/contracts/domain.js";
import { FinancialDecimal } from "../../src/contracts/financial-decimal.js";
import {
  type OrderResponse,
  OrderResponseSchema,
} from "../../src/contracts/orders.js";
import {
  PortfolioResponseSchema,
  serializeQuantityShares,
} from "../../src/contracts/portfolio.js";

const at = new Date("2026-01-05T10:00:00Z");

/** Movimiento de trading con el borde INT4 y el máximo monetario de D1. */
const tradingMovement = {
  side: "BUY",
  instrumentId: 7,
  sizeShares: 2147483647,
  priceArs: new FinancialDecimal("9999999999999999999999.99"),
} satisfies TradingSettledOrderMovement;

/** Movimiento de cash con centavos: no tiene acciones ni precio. */
const cashMovement = {
  side: "CASH_IN",
  amountArs: new FinancialDecimal("123.45"),
} satisfies CashSettledOrderMovement;

/** Narrowing por `side`: cada rama accede SÓLO a la unidad que le toca. */
const describeMovement = (movement: SettledOrderMovement): string =>
  movement.side === "CASH_IN" || movement.side === "CASH_OUT"
    ? `cash ${movement.amountArs.toFixed(2)}`
    : `shares ${String(movement.sizeShares)} @ ${movement.priceArs.toFixed(2)}`;

/** Fila de trading: conserva la nullabilidad legacy de instrumentId/userId. */
const tradingRecord = {
  id: 1,
  instrumentId: null,
  userId: null,
  side: "SELL",
  type: "LIMIT",
  timeInForce: "GTC",
  status: "NEW",
  sizeShares: 10,
  priceArs: new FinancialDecimal("100.00"),
  filledPriceArs: null,
  filledAt: null,
  idempotencyKey: null,
  datetime: at,
} satisfies TradingOrderRecord;

/** Fila de cash: la columna física size es un monto, no una cantidad. */
const cashRecord = {
  id: 2,
  instrumentId: 9,
  userId: 3,
  side: "CASH_OUT",
  type: "MARKET",
  timeInForce: "GTC",
  status: "FILLED",
  amountArs: new FinancialDecimal("123.45"),
  priceArs: new FinancialDecimal("1.00"),
  filledPriceArs: new FinancialDecimal("1.00"),
  filledAt: at,
  idempotencyKey: "transfer-key",
  datetime: at,
} satisfies CashOrderRecord;

const sizeOfRecord = (order: OrderRecord): string =>
  order.side === "CASH_IN" || order.side === "CASH_OUT"
    ? order.amountArs.toFixed(2)
    : order.sizeShares === null
      ? "null"
      : String(order.sizeShares);

const tradingDraft = {
  userId: 3,
  instrumentId: 9,
  side: "BUY",
  type: "MARKET",
  timeInForce: "IOC",
  status: "FILLED",
  sizeShares: 1,
  priceArs: null,
  filledPriceArs: new FinancialDecimal("100.00"),
  filledAt: at,
  idempotencyKey: null,
  datetime: at,
} satisfies TradingOrderDraft;

const cashDraft = {
  userId: 3,
  instrumentId: 9,
  side: "CASH_IN",
  type: "MARKET",
  timeInForce: "GTC",
  status: "FILLED",
  amountArs: new FinancialDecimal("0.01"),
  priceArs: new FinancialDecimal("1.00"),
  filledPriceArs: new FinancialDecimal("1.00"),
  filledAt: at,
  idempotencyKey: null,
  datetime: at,
} satisfies CashOrderDraft;

// Aserciones de tipo: la rama cash NO expone sizeShares y la de trading NO
// expone amountArs. Si alguien vuelve a unificar el campo, el alias deja de
// ser `true` y `npm run typecheck` falla (sin @ts-expect-error ni any).
type CashMovementHasNoShares = "sizeShares" extends keyof CashSettledOrderMovement
  ? false
  : true;
type TradingMovementHasNoAmount = "amountArs" extends keyof TradingSettledOrderMovement
  ? false
  : true;
type CashRecordHasNoShares = "sizeShares" extends keyof CashOrderRecord ? false : true;
type TradingRecordHasNoAmount = "amountArs" extends keyof TradingOrderRecord ? false : true;

type CashResponse = Extract<OrderResponse, { side: "CASH_IN" | "CASH_OUT" }>;
type TradingResponse = Extract<OrderResponse, { side: "BUY" | "SELL" }>;
type CashSizeIsString = string extends CashResponse["size"] ? true : false;
type TradingSizeIsNumberOrNull = null extends TradingResponse["size"]
  ? number extends TradingResponse["size"]
    ? true
    : false
  : false;

describe("uniones cash/trading — el compilador separa las unidades", () => {
  it("fixtures satisfacen cada rama y el narrowing accede a la unidad correcta", () => {
    expect(describeMovement(tradingMovement)).toBe(
      "shares 2147483647 @ 9999999999999999999999.99",
    );
    expect(describeMovement(cashMovement)).toBe("cash 123.45");
  });

  it("las ramas no mezclan sizeShares con amountArs", () => {
    const cashMovementHasNoShares: CashMovementHasNoShares = true;
    const tradingMovementHasNoAmount: TradingMovementHasNoAmount = true;
    const cashRecordHasNoShares: CashRecordHasNoShares = true;
    const tradingRecordHasNoAmount: TradingRecordHasNoAmount = true;
    expect([
      cashMovementHasNoShares,
      tradingMovementHasNoAmount,
      cashRecordHasNoShares,
      tradingRecordHasNoAmount,
    ]).toEqual([true, true, true, true]);
  });

  it("OrderRecord discrimina la fila y preserva la nullabilidad legacy", () => {
    expect(sizeOfRecord(tradingRecord)).toBe("10");
    expect(sizeOfRecord(cashRecord)).toBe("123.45");
    expect(tradingRecord.instrumentId).toBeNull();
    expect(tradingRecord.userId).toBeNull();
    expect(cashRecord.amountArs.toFixed(2)).toBe("123.45");
  });

  it("OrderDraft discrimina el payload a persistir (acciones vs monto exacto)", () => {
    const drafts: readonly OrderDraft[] = [tradingDraft, cashDraft];
    const rendered = drafts.map((draft) =>
      draft.side === "CASH_IN" || draft.side === "CASH_OUT"
        ? draft.amountArs.toFixed(2)
        : String(draft.sizeShares),
    );
    expect(rendered).toEqual(["1", "0.01"]);
  });
});

describe("cantidades agregadas — bigint interno", () => {
  it("Reservations acumula bigint más allá del entero seguro sin pasar por number", () => {
    const beyondSafeInteger = 9_007_199_254_740_993n;
    const reservations = {
      cashReservedArs: new FinancialDecimal("1.00"),
      sharesReservedByInstrument: new Map<number, bigint>([
        [7, beyondSafeInteger],
      ]),
    } satisfies Reservations;

    const total = [...reservations.sharesReservedByInstrument.values()].reduce(
      (sum, shares) => sum + shares,
      0n,
    );
    expect(total).toBe(beyondSafeInteger);
    expect(typeof total).toBe("bigint");
    expect(total.toString()).toBe("9007199254740993");
  });

  it("PositionPnl expone quantityShares bigint y money exacto", () => {
    const position = {
      instrumentId: 7,
      quantityShares: 9_007_199_254_740_993n,
      weightedAverageCostArs: new FinancialDecimal("10.00"),
      marketValueArs: new FinancialDecimal("90071992547409930.00"),
      priceAvailable: true,
      totalReturnPctX100: new FinancialDecimal("0.00"),
    } satisfies PositionPnl;

    expect(position.quantityShares).toBe(9_007_199_254_740_993n);
    expect(position.marketValueArs?.toFixed(2)).toBe("90071992547409930.00");
  });
});

describe("OrderResponseSchema — size discriminado por side", () => {
  const tradingResponse = {
    id: 1,
    instrumentId: 2,
    side: "BUY",
    type: "LIMIT",
    timeInForce: "GTC",
    status: "FILLED",
    size: 10,
    price: "100.00",
    filledPrice: "100.00",
    filledAt: "2026-01-05T10:00:00",
    datetime: "2026-01-05T10:00:00",
    reason: null,
  } as const;

  const cashResponse = {
    id: 2,
    instrumentId: 9,
    side: "CASH_IN",
    type: "MARKET",
    timeInForce: "GTC",
    status: "FILLED",
    size: "123.00",
    price: "1.00",
    filledPrice: "1.00",
    filledAt: "2026-01-05T10:00:00",
    datetime: "2026-01-05T10:00:00",
    reason: null,
  } as const;

  it("trading: size number entero (o null) sigue igual que hoy", () => {
    expect(OrderResponseSchema.safeParse(tradingResponse).success).toBe(true);
    expect(
      OrderResponseSchema.safeParse({ ...tradingResponse, size: null, status: "NEW" })
        .success,
    ).toBe(true);
    expect(
      OrderResponseSchema.safeParse({ ...tradingResponse, size: "10.00" }).success,
    ).toBe(false);
    expect(
      OrderResponseSchema.safeParse({ ...tradingResponse, size: 1.5 }).success,
    ).toBe(false);
  });

  it("cash: size es string monetario de 2 decimales (histórico 123 → '123.00')", () => {
    expect(OrderResponseSchema.safeParse(cashResponse).success).toBe(true);
    for (const size of ["0.01", "123.45", "9999999999999999999999.99"]) {
      expect(OrderResponseSchema.safeParse({ ...cashResponse, size }).success).toBe(true);
    }
    for (const size of [123, "123", "123.4", "-0.00", "1e3"]) {
      expect(OrderResponseSchema.safeParse({ ...cashResponse, size }).success).toBe(false);
    }
  });

  it("no se agrega ni se quita ningún otro campo (shape vigente intacto)", () => {
    const withoutReason: Record<string, unknown> = { ...cashResponse };
    delete withoutReason["reason"];
    expect(OrderResponseSchema.safeParse(withoutReason).success).toBe(false);
    expect(
      OrderResponseSchema.safeParse({ ...cashResponse, filledPrice: 1 }).success,
    ).toBe(false);
  });

  it("tipos inferidos: cash string, trading number|null", () => {
    const cashSizeIsString: CashSizeIsString = true;
    const tradingSizeIsNumberOrNull: TradingSizeIsNumberOrNull = true;
    expect([cashSizeIsString, tradingSizeIsNumberOrNull]).toEqual([true, true]);
  });
});

describe("PortfolioResponseSchema — quantity string entero canónico", () => {
  const portfolio = (quantity: unknown) => ({
    cash: "1000.00",
    reservedCash: "0.00",
    totalAccountValue: "90071992547409930.00",
    positions: [
      {
        ticker: "GGAL",
        name: "Grupo Financiero Galicia",
        quantity,
        marketValue: "90071992547409930.00",
        priceAvailable: true,
        totalReturnPct: 1.23,
      },
    ],
  });

  it("acepta cantidades mayores al entero seguro y posiciones negativas heredadas", () => {
    for (const quantity of ["9007199254740993", "-10", "0"]) {
      expect(PortfolioResponseSchema.safeParse(portfolio(quantity)).success).toBe(true);
    }
  });

  it("rechaza number y formas no canónicas (ceros iniciales, +, -0, fracción, exponente)", () => {
    for (const quantity of [10, "01", "+1", "-0", "1.0", "1e3", " 1"]) {
      expect(PortfolioResponseSchema.safeParse(portfolio(quantity)).success).toBe(false);
    }
  });

  it("serializeQuantityShares emite el string que el schema acepta y JSON lo conserva", () => {
    for (const quantity of [9_007_199_254_740_993n, 0n, -10n]) {
      const serialized = serializeQuantityShares(quantity);
      expect(PortfolioResponseSchema.safeParse(portfolio(serialized)).success).toBe(true);
    }
    const body = portfolio(serializeQuantityShares(9_007_199_254_740_993n));
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("la posición es strictObject: un campo extra se rechaza en vez de descartarse", () => {
    // Era el único z.object NO estricto del contrato (E-05): un campo de más
    // debe romper el contrato (y OpenAPI lo declara con
    // `additionalProperties: false`), no desaparecer en silencio con strip.
    const withExtra = portfolio("10") as unknown as {
      positions: Record<string, unknown>[];
    };
    withExtra.positions[0] = { ...withExtra.positions[0], unexpected: 1 };
    expect(PortfolioResponseSchema.safeParse(withExtra).success).toBe(false);

    const atTop = { ...portfolio("10"), unexpected: 1 };
    expect(PortfolioResponseSchema.safeParse(atTop).success).toBe(false);
  });
});
