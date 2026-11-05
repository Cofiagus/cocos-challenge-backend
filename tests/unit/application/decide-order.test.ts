// Tests DIRECTOS de las decisiones puras de UC-3: sin ports, sin DB y sin
// reloj. Cada borde está escrito a mano con Decimal desde string (AGENTS.md):
// fondos/vendible exactamente iguales no rechazan y un centavo/una acción más
// sí; el residuo del monto y el cruce con límite == referencia se fijan acá.

import { Decimal } from "decimal.js";
import { FinancialDecimal } from "../../../src/contracts/index.js";
import {
  assessFunds,
  buildAuditBase,
  decideAcceptedOrder,
  decideLimitOrder,
  decideMarketFill,
  limitPriceOf,
  needsReferencePrice,
  positionSharesFor,
  rejectForMissingPrice,
  rejectForZeroSize,
  resolveSizing,
  type FundsAssessmentInput,
  type SizingDecision,
} from "../../../src/application/orders/decide-order.js";
import type {
  CreateOrderRequest,
  InstrumentRecord,
  OrderEventMetadata,
  Reservations,
  SettledOrderMovement,
  TimeInForce,
} from "../../../src/contracts/index.js";

// ---------------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------------

const PAMP: InstrumentRecord = {
  id: 1,
  ticker: "PAMP",
  name: "Pampa Holding S.A.",
  type: "ACCIONES",
};

const auditBase = (overrides: OrderEventMetadata = {}): OrderEventMetadata => ({
  ticker: "PAMP",
  referencePriceArs: "925.85",
  sizingPriceArs: null,
  sizeDerivedFromAmount: false,
  residualArs: null,
  ...overrides,
});

const noReservations: Reservations = {
  cashReservedArs: new Decimal(0),
  sharesReservedByInstrument: new Map(),
};

interface RequestFields {
  readonly side?: "BUY" | "SELL";
  readonly timeInForce?: TimeInForce;
  readonly size?: number;
  readonly amountArs?: Decimal;
  readonly price?: Decimal | null;
}

const marketRequest = (fields: RequestFields = {}): CreateOrderRequest => ({
  instrumentId: 1,
  side: fields.side ?? "BUY",
  type: "MARKET",
  timeInForce: fields.timeInForce ?? "GTC",
  ...(fields.size === undefined ? {} : { size: fields.size }),
  ...(fields.amountArs === undefined ? {} : { amountArs: fields.amountArs }),
});

const limitRequest = (fields: RequestFields = {}): CreateOrderRequest => ({
  instrumentId: 1,
  side: fields.side ?? "BUY",
  type: "LIMIT",
  timeInForce: fields.timeInForce ?? "GTC",
  ...(fields.size === undefined ? {} : { size: fields.size }),
  ...(fields.amountArs === undefined ? {} : { amountArs: fields.amountArs }),
  ...(fields.price === undefined ? {} : { price: fields.price }),
});

/** CASH_IN de un monto exacto en ARS: el cash no lleva acciones ni precio. */
const cashIn = (amountArs: string): SettledOrderMovement => ({
  side: "CASH_IN",
  amountArs: new Decimal(amountArs),
});

const trade = (
  instrumentId: number,
  side: "BUY" | "SELL",
  sizeShares: number,
  priceArs: string,
): SettledOrderMovement => ({
  instrumentId,
  side,
  sizeShares,
  priceArs: new Decimal(priceArs),
});

const sizing = (overrides: Partial<SizingDecision> = {}): SizingDecision => ({
  sizeShares: 1,
  sizingPriceArs: null,
  residualArs: null,
  ...overrides,
});

const fundsInput = (
  fields: Partial<FundsAssessmentInput> = {},
): FundsAssessmentInput => ({
  request: marketRequest({ size: 1 }),
  instrumentId: 1,
  sizeShares: 1,
  referencePriceArs: new Decimal("1000.00"),
  limitPriceArs: null,
  movements: [],
  reservations: noReservations,
  auditBase: auditBase(),
  ...fields,
});

const acceptedInput = (
  fields: Partial<Parameters<typeof decideAcceptedOrder>[0]> = {},
): Parameters<typeof decideAcceptedOrder>[0] => ({
  request: marketRequest({ size: 1 }),
  sizeShares: 1,
  referencePriceArs: new Decimal("925.85"),
  limitPriceArs: null,
  auditBase: auditBase(),
  decidedAt: new Date("2023-07-14T10:00:00.000Z"),
  ...fields,
});

// ---------------------------------------------------------------------------
// needsReferencePrice / limitPriceOf
// ---------------------------------------------------------------------------

describe("needsReferencePrice", () => {
  it.each([
    ["MARKET GTC", marketRequest({ size: 1 }), true],
    ["LIMIT IOC", limitRequest({ timeInForce: "IOC", size: 1, price: new Decimal("1.00") }), true],
    ["LIMIT FOK", limitRequest({ timeInForce: "FOK", size: 1, price: new Decimal("1.00") }), true],
    ["LIMIT GTC", limitRequest({ timeInForce: "GTC", size: 1, price: new Decimal("1.00") }), false],
  ] as const)("%s ⇒ %s", (_name, request, expected) => {
    expect(needsReferencePrice(request)).toBe(expected);
  });
});

describe("limitPriceOf", () => {
  it("LIMIT devuelve el precio límite", () => {
    expect(limitPriceOf(limitRequest({ size: 1, price: new Decimal("250.00") }))).toEqual(
      new Decimal("250.00"),
    );
  });

  it("LIMIT sin price (contrato violado) ⇒ null", () => {
    expect(limitPriceOf(limitRequest({ size: 1 }))).toBeNull();
  });

  it("MARKET con price null ⇒ null", () => {
    const request: CreateOrderRequest = {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
      price: null,
    };
    expect(limitPriceOf(request)).toBeNull();
  });

  it("MARKET sin price ⇒ null", () => {
    expect(limitPriceOf(marketRequest({ size: 1 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rejectForMissingPrice
// ---------------------------------------------------------------------------

describe("rejectForMissingPrice", () => {
  it("size explícito ⇒ REJECTED NO_PRICE con ese size y sólo el ticker", () => {
    expect(
      rejectForMissingPrice(marketRequest({ size: 10 }), PAMP),
    ).toEqual({
      status: "REJECTED",
      sizeShares: 10,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "NO_PRICE",
      metadata: { ticker: "PAMP" },
    });
  });

  it("amountArs ⇒ NO_PRICE con size 0 (no es sizable sin precio)", () => {
    expect(
      rejectForMissingPrice(marketRequest({ amountArs: new Decimal("5000.00") }), PAMP),
    ).toEqual({
      status: "REJECTED",
      sizeShares: 0,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "NO_PRICE",
      metadata: { ticker: "PAMP" },
    });
  });
});

// ---------------------------------------------------------------------------
// resolveSizing
// ---------------------------------------------------------------------------

describe("resolveSizing", () => {
  it("size explícito no deriva ni calcula residuo", () => {
    expect(
      resolveSizing(limitRequest({ size: 7, price: new Decimal("10.00") }), null, new Decimal("10.00")),
    ).toEqual({ sizeShares: 7, sizingPriceArs: null, residualArs: null });
  });

  it("amountArs MARKET ⇒ floor(amount/ref) y el residuo exacto", () => {
    // 10000 / 925.85 = 10.80... ⇒ 10 acciones; residuo 10000 − 10×925.85.
    expect(
      resolveSizing(
        marketRequest({ amountArs: new Decimal("10000.00") }),
        new Decimal("925.85"),
        null,
      ),
    ).toEqual({
      sizeShares: 10,
      sizingPriceArs: new Decimal("925.85"),
      residualArs: new Decimal("741.50"),
    });
  });

  it("amountArs múltiplo exacto del precio ⇒ residuo 0", () => {
    expect(
      resolveSizing(
        marketRequest({ amountArs: new Decimal("1000.00") }),
        new Decimal("250.00"),
        null,
      ),
    ).toEqual({
      sizeShares: 4,
      sizingPriceArs: new Decimal("250.00"),
      residualArs: new Decimal("0"),
    });
  });

  it("amountArs LIMIT usa el límite, no la referencia", () => {
    expect(
      resolveSizing(
        limitRequest({ amountArs: new Decimal("1000.00"), price: new Decimal("300.00") }),
        new Decimal("925.85"),
        new Decimal("300.00"),
      ),
    ).toEqual({
      sizeShares: 3,
      sizingPriceArs: new Decimal("300.00"),
      residualArs: new Decimal("100"),
    });
  });

  it("sin size ni amountArs ⇒ guard de XOR del borde", () => {
    expect(() => resolveSizing(marketRequest(), null, null)).toThrow(
      "Envío sin size ni amountArs (inalcanzable: XOR del borde).",
    );
  });

  it("amountArs MARKET sin referencia ⇒ guard de precio de sizing", () => {
    expect(() =>
      resolveSizing(marketRequest({ amountArs: new Decimal("1000.00") }), null, null),
    ).toThrow("Precio de sizing no resuelto (inalcanzable tras NO_PRICE/contrato).");
  });

  it("amountArs LIMIT sin precio ⇒ guard de precio de sizing", () => {
    expect(() =>
      resolveSizing(limitRequest({ amountArs: new Decimal("1000.00") }), null, null),
    ).toThrow("Precio de sizing no resuelto (inalcanzable tras NO_PRICE/contrato).");
  });
});

// ---------------------------------------------------------------------------
// buildAuditBase / rejectForZeroSize
// ---------------------------------------------------------------------------

describe("buildAuditBase", () => {
  it("size explícito: referencia en 2 decimales, sin sizing ni residuo", () => {
    expect(
      buildAuditBase(
        PAMP,
        marketRequest({ size: 3 }),
        new Decimal("925.85"),
        sizing({ sizeShares: 3 }),
      ),
    ).toEqual({
      ticker: "PAMP",
      referencePriceArs: "925.85",
      sizingPriceArs: null,
      sizeDerivedFromAmount: false,
      residualArs: null,
    });
  });

  it("size derivado del monto: sizing y residuo como strings de 2 decimales", () => {
    expect(
      buildAuditBase(
        PAMP,
        marketRequest({ amountArs: new Decimal("10000.00") }),
        new Decimal("925.85"),
        sizing({
          sizeShares: 10,
          sizingPriceArs: new Decimal("925.85"),
          residualArs: new Decimal("741.50"),
        }),
      ),
    ).toEqual({
      ticker: "PAMP",
      referencePriceArs: "925.85",
      sizingPriceArs: "925.85",
      sizeDerivedFromAmount: true,
      residualArs: "741.50",
    });
  });

  it("sin referencia ni sizing ⇒ nulls (LIMIT GTC)", () => {
    expect(
      buildAuditBase(PAMP, limitRequest({ size: 2, price: new Decimal("250.00") }), null, sizing()),
    ).toEqual({
      ticker: "PAMP",
      referencePriceArs: null,
      sizingPriceArs: null,
      sizeDerivedFromAmount: false,
      residualArs: null,
    });
  });
});

describe("rejectForZeroSize", () => {
  it("⇒ REJECTED ZERO_SIZE con la metadata de auditoría tal cual", () => {
    const metadata = auditBase({
      sizingPriceArs: "925.85",
      sizeDerivedFromAmount: true,
      residualArs: "100.00",
    });
    expect(rejectForZeroSize(metadata)).toEqual({
      status: "REJECTED",
      sizeShares: 0,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "ZERO_SIZE",
      metadata,
    });
  });
});

// ---------------------------------------------------------------------------
// positionSharesFor
// ---------------------------------------------------------------------------

describe("positionSharesFor", () => {
  it("BUY suma y SELL resta en el instrumento pedido, en bigint", () => {
    expect(
      positionSharesFor(
        [trade(1, "BUY", 10, "900.00"), trade(1, "SELL", 3, "1100.00")],
        1,
      ),
    ).toBe(7n);
  });

  it("ignora otros instrumentos y los movimientos de cash (no tienen instrumentId)", () => {
    expect(
      positionSharesFor(
        [
          cashIn("100000.00"),
          trade(1, "BUY", 10, "900.00"),
          trade(2, "BUY", 5, "100.00"),
          { side: "CASH_OUT", amountArs: new Decimal("4.00") },
        ],
        1,
      ),
    ).toBe(10n);
  });

  it("acumula en bigint el retorno (sin pasar la cantidad agregada por number)", () => {
    // Cada orden está acotada a INT4; la ACUMULACIÓN puede superar 2^53.
    expect(
      positionSharesFor(
        [
          trade(1, "BUY", 2147483647, "1.00"),
          trade(1, "BUY", 2147483647, "1.00"),
          trade(1, "BUY", 2147483647, "1.00"),
          trade(1, "BUY", 2147483647, "1.00"),
        ],
        1,
      ),
    ).toBe(8589934588n);
  });
});

// ---------------------------------------------------------------------------
// assessFunds — BUY
// ---------------------------------------------------------------------------

describe("assessFunds BUY", () => {
  it("costo EXACTAMENTE igual al cash disponible ⇒ no rechaza", () => {
    expect(
      assessFunds(
        fundsInput({
          request: marketRequest({ size: 1 }),
          sizeShares: 1,
          referencePriceArs: new Decimal("1000.00"),
          movements: [cashIn("1000.00")],
        }),
      ),
    ).toBeNull();
  });

  it("un centavo más ⇒ REJECTED INSUFFICIENT_FUNDS con costo y cash", () => {
    expect(
      assessFunds(
        fundsInput({
          request: marketRequest({ size: 1 }),
          sizeShares: 1,
          referencePriceArs: new Decimal("1000.01"),
          movements: [cashIn("1000.00")],
        }),
      ),
    ).toEqual({
      status: "REJECTED",
      sizeShares: 1,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "INSUFFICIENT_FUNDS",
      metadata: {
        ...auditBase(),
        requiredCostArs: "1000.01",
        cashAvailableArs: "1000.00",
      },
    });
  });

  it("las reservas de BUY NEW bajan el cash disponible", () => {
    expect(
      assessFunds(
        fundsInput({
          request: marketRequest({ size: 10 }),
          sizeShares: 10,
          referencePriceArs: new Decimal("100.00"),
          movements: [cashIn("1000.00")],
          reservations: {
            cashReservedArs: new Decimal("1.00"),
            sharesReservedByInstrument: new Map(),
          },
        }),
      ),
    ).toEqual({
      status: "REJECTED",
      sizeShares: 10,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "INSUFFICIENT_FUNDS",
      metadata: {
        ...auditBase(),
        requiredCostArs: "1000.00",
        cashAvailableArs: "999.00",
      },
    });
  });

  it("LIMIT valida al precio límite, no a la referencia", () => {
    expect(
      assessFunds(
        fundsInput({
          request: limitRequest({ size: 5, price: new Decimal("250.00") }),
          sizeShares: 5,
          referencePriceArs: new Decimal("925.85"),
          limitPriceArs: new Decimal("250.00"),
          movements: [cashIn("1250.00")],
        }),
      ),
    ).toBeNull();
  });

  it("MARKET sin precio de validación ⇒ guard inalcanzable", () => {
    expect(() =>
      assessFunds(
        fundsInput({
          request: marketRequest({ size: 1 }),
          referencePriceArs: null,
        }),
      ),
    ).toThrow("Precio de validación no resuelto (inalcanzable).");
  });

  it("LIMIT sin precio de validación ⇒ guard inalcanzable", () => {
    expect(() =>
      assessFunds(
        fundsInput({
          request: limitRequest({ size: 1 }),
          limitPriceArs: null,
        }),
      ),
    ).toThrow("Precio de validación no resuelto (inalcanzable).");
  });
});

// ---------------------------------------------------------------------------
// assessFunds — SELL
// ---------------------------------------------------------------------------

describe("assessFunds SELL", () => {
  const sellInput = (
    sizeShares: number,
    reservations: Reservations = noReservations,
  ): FundsAssessmentInput =>
    fundsInput({
      request: marketRequest({ side: "SELL", size: sizeShares }),
      sizeShares,
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
      reservations,
    });

  it("size EXACTAMENTE el vendible ⇒ no rechaza (límite inclusivo)", () => {
    const reservations: Reservations = {
      cashReservedArs: new Decimal(0),
      sharesReservedByInstrument: new Map([[1, 4n]]),
    };
    expect(assessFunds(sellInput(6, reservations))).toBeNull();
  });

  it("una acción más ⇒ REJECTED INSUFFICIENT_POSITION con posición/reserva/vendible", () => {
    const reservations: Reservations = {
      cashReservedArs: new Decimal(0),
      sharesReservedByInstrument: new Map([[1, 4n]]),
    };
    expect(assessFunds(sellInput(7, reservations))).toEqual({
      status: "REJECTED",
      sizeShares: 7,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "INSUFFICIENT_POSITION",
      metadata: {
        ...auditBase(),
        positionShares: "10",
        reservedShares: "4",
        sellableShares: "6",
      },
    });
  });

  it("posición negativa del seed ⇒ vendible negativo ⇒ rechaza", () => {
    const input = fundsInput({
      request: marketRequest({ side: "SELL", size: 1 }),
      sizeShares: 1,
      movements: [
        cashIn("100000.00"),
        trade(1, "BUY", 20, "900.00"),
        trade(1, "SELL", 30, "1100.00"),
      ],
    });
    expect(assessFunds(input)).toEqual({
      status: "REJECTED",
      sizeShares: 1,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "INSUFFICIENT_POSITION",
      metadata: {
        ...auditBase(),
        positionShares: "-10",
        reservedShares: "0",
        sellableShares: "-10",
      },
    });
  });

  it("reservas mayores al entero seguro ⇒ comparación bigint y metadata string exacta", () => {
    const reservations: Reservations = {
      cashReservedArs: new Decimal(0),
      sharesReservedByInstrument: new Map([[1, 9007199254740993n]]),
    };
    expect(assessFunds(sellInput(10, reservations))).toEqual({
      status: "REJECTED",
      sizeShares: 10,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "INSUFFICIENT_POSITION",
      metadata: {
        ...auditBase(),
        positionShares: "10",
        reservedShares: "9007199254740993",
        sellableShares: "-9007199254740983",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// decideAcceptedOrder — MARKET
// ---------------------------------------------------------------------------

describe("decideAcceptedOrder — MARKET", () => {
  const decidedAt = new Date("2023-07-14T11:00:00.000Z");

  it("⇒ FILLED a la referencia en el instante de decisión", () => {
    expect(
      decideAcceptedOrder(
        acceptedInput({
          request: marketRequest({ size: 3 }),
          sizeShares: 3,
          referencePriceArs: new Decimal("925.85"),
          decidedAt,
        }),
      ),
    ).toEqual({
      status: "FILLED",
      sizeShares: 3,
      filledPriceArs: new Decimal("925.85"),
      filledAt: decidedAt,
      eventType: "ACCEPTED",
      reason: null,
      metadata: auditBase(),
    });
  });

  it("MARKET sin referencia ⇒ guard inalcanzable", () => {
    expect(() =>
      decideMarketFill(
        acceptedInput({
          request: marketRequest({ size: 1 }),
          referencePriceArs: null,
        }),
      ),
    ).toThrow("MARKET sin precio de referencia (inalcanzable: NO_PRICE salió).");
  });
});

// ---------------------------------------------------------------------------
// decideAcceptedOrder — LIMIT
// ---------------------------------------------------------------------------

describe("decideAcceptedOrder — LIMIT", () => {
  const decidedAt = new Date("2023-07-14T11:00:00.000Z");

  it("GTC ⇒ NEW sin precio de fill ni instante", () => {
    expect(
      decideAcceptedOrder(
        acceptedInput({
          request: limitRequest({ size: 2, price: new Decimal("250.00") }),
          sizeShares: 2,
          referencePriceArs: null,
          limitPriceArs: new Decimal("250.00"),
          auditBase: auditBase({ referencePriceArs: null }),
          decidedAt,
        }),
      ),
    ).toEqual({
      status: "NEW",
      sizeShares: 2,
      filledPriceArs: null,
      filledAt: null,
      eventType: "ACCEPTED",
      reason: null,
      metadata: auditBase({ referencePriceArs: null }),
    });
  });

  it("IOC BUY con referencia == límite ⇒ FILLED al límite (sin mejora)", () => {
    expect(
      decideLimitOrder(
        acceptedInput({
          request: limitRequest({ timeInForce: "IOC", size: 2, price: new Decimal("925.85") }),
          sizeShares: 2,
          referencePriceArs: new Decimal("925.85"),
          limitPriceArs: new Decimal("925.85"),
          decidedAt,
        }),
      ),
    ).toEqual({
      status: "FILLED",
      sizeShares: 2,
      // evaluateCross (dominio) construye el precio con el constructor financiero.
      filledPriceArs: new FinancialDecimal("925.85"),
      filledAt: decidedAt,
      eventType: "ACCEPTED",
      reason: null,
      metadata: { ...auditBase(), limitPriceArs: "925.85" },
    });
  });

  it("IOC BUY que no cruza ⇒ CANCELLED NO_IMMEDIATE_MATCH con el límite", () => {
    expect(
      decideLimitOrder(
        acceptedInput({
          request: limitRequest({ timeInForce: "IOC", size: 2, price: new Decimal("900.00") }),
          sizeShares: 2,
          referencePriceArs: new Decimal("925.85"),
          limitPriceArs: new Decimal("900.00"),
        }),
      ),
    ).toEqual({
      status: "CANCELLED",
      sizeShares: 2,
      filledPriceArs: null,
      filledAt: null,
      eventType: "CANCELLED",
      reason: "NO_IMMEDIATE_MATCH",
      metadata: { ...auditBase(), limitPriceArs: "900.00" },
    });
  });

  it("IOC SELL que cruza ⇒ FILLED a max(límite, referencia)", () => {
    expect(
      decideLimitOrder(
        acceptedInput({
          request: limitRequest({ side: "SELL", timeInForce: "IOC", size: 2, price: new Decimal("900.00") }),
          sizeShares: 2,
          referencePriceArs: new Decimal("925.85"),
          limitPriceArs: new Decimal("900.00"),
          decidedAt,
        }),
      ),
    ).toEqual({
      status: "FILLED",
      sizeShares: 2,
      filledPriceArs: new FinancialDecimal("925.85"),
      filledAt: decidedAt,
      eventType: "ACCEPTED",
      reason: null,
      metadata: { ...auditBase(), limitPriceArs: "900.00" },
    });
  });

  it("IOC/FOK sin referencia ⇒ guard inalcanzable", () => {
    expect(() =>
      decideLimitOrder(
        acceptedInput({
          request: limitRequest({ timeInForce: "IOC", size: 1, price: new Decimal("900.00") }),
          referencePriceArs: null,
          limitPriceArs: new Decimal("900.00"),
        }),
      ),
    ).toThrow("IOC/FOK sin precio de referencia (inalcanzable: NO_PRICE salió).");
  });

  it("LIMIT sin límite ⇒ guard inalcanzable", () => {
    expect(() =>
      decideLimitOrder(
        acceptedInput({
          request: limitRequest({ timeInForce: "IOC", size: 1 }),
          limitPriceArs: null,
        }),
      ),
    ).toThrow("LIMIT sin límite (inalcanzable: contrato del borde).");
  });

  it("evaluación IOC/FOK que responde NEW ⇒ guard inalcanzable", () => {
    let reads = 0;
    const lyingRequest: CreateOrderRequest = {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      size: 1,
      price: new Decimal("950.00"),
      get timeInForce(): TimeInForce {
        reads += 1;
        return reads === 1 ? "IOC" : "GTC";
      },
    };
    expect(() =>
      decideLimitOrder(
        acceptedInput({
          request: lyingRequest,
          limitPriceArs: new Decimal("950.00"),
        }),
      ),
    ).toThrow("Evaluación IOC/FOK sin decisión (inalcanzable).");
  });
});
