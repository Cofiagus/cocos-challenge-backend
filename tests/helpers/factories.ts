// Factories de tests contra Prisma (FASE 1 — Célula 0).
//
// AGENTS.md: el dinero NUNCA va como float — los overrides de dinero son
// STRINGS ("930.00") y el driver de Prisma las parsea a Decimal.
//
// Ninguna factory INSTANCIA el PrismaClient (en Prisma 7 requiere driver
// adapter, decisión de la célula B en FASE 2): lo reciben como parámetro,
// que es además lo que permite los tests unitarios con clientes fake.

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  InstrumentType,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
} from "../../src/contracts/enums.js";

export interface TestUserOverrides {
  readonly email?: string;
  readonly accountNumber?: string;
}

export const createTestUser = async (
  prisma: PrismaClient,
  overrides: TestUserOverrides = {},
) =>
  prisma.user.create({
    data: {
      email: overrides.email ?? `test-${randomUUID()}@test.com`,
      accountNumber:
        overrides.accountNumber ??
        randomUUID().replace(/[^0-9]/g, "").slice(0, 10).padStart(6, "0"),
    },
  });

export interface TestInstrumentOverrides {
  readonly ticker?: string;
  readonly name?: string;
  readonly type?: InstrumentType;
}

export const createTestInstrument = async (
  prisma: PrismaClient,
  overrides: TestInstrumentOverrides = {},
) => {
  const ticker = overrides.ticker ?? `T${randomUUID().slice(2, 10)}`;
  return prisma.instrument.create({
    data: {
      ticker,
      name: overrides.name ?? `Test instrument ${ticker}`,
      type: overrides.type ?? "ACCIONES",
    },
  });
};

export interface TestOrderOverrides {
  readonly userId: number;
  readonly instrumentId: number;
  readonly side?: OrderSide;
  readonly type?: OrderType;
  readonly status?: OrderStatus;
  readonly timeInForce?: TimeInForce;
  /** Unidad física de size: acciones (number) o monto cash ARS (string exacto). */
  readonly size?: number | string;
  /** Dinero como STRING (nunca float); null en MARKET sin límite. */
  readonly priceArs?: string | null;
  readonly filledPriceArs?: string | null;
  readonly filledAt?: Date | null;
  readonly idempotencyKey?: string | null;
  readonly datetime?: Date;
}

/**
 * Tipo efectivo de la orden: LIMIT si el override no lo dice.
 */
const orderTypeOf = (overrides: TestOrderOverrides): OrderType =>
  overrides.type ?? "LIMIT";

/**
 * Status coherente con el tipo: una LIMIT nace NEW; una MARKET se ejecuta
 * (FILLED).
 */
const orderStatusOf = (
  overrides: TestOrderOverrides,
  type: OrderType,
): OrderStatus => overrides.status ?? (type === "LIMIT" ? "NEW" : "FILLED");

/**
 * Límite enviado: 100.00 en LIMIT, null en MARKET (sin precio de referencia).
 */
const orderPriceArsOf = (
  overrides: TestOrderOverrides,
  type: OrderType,
): string | null =>
  overrides.priceArs ?? (type === "LIMIT" ? "100.00" : null);

/**
 * Campos de ejecución/auditoría: sin ejecución ni idempotency key salvo
 * override; `datetime` es el momento de la creación.
 */
const orderExecutionFieldsOf = (overrides: TestOrderOverrides) => ({
  filledPrice: overrides.filledPriceArs ?? null,
  filledAt: overrides.filledAt ?? null,
  idempotencyKey: overrides.idempotencyKey ?? null,
  datetime: overrides.datetime ?? new Date(),
});

/**
 * Orden default: LIMIT BUY NEW GTC, size 10 @ 100.00 — el resting order
 * vanilla del que parten casi todos los tests.
 */
export const createTestOrder = async (
  prisma: PrismaClient,
  overrides: TestOrderOverrides,
) => {
  const type = orderTypeOf(overrides);
  return prisma.order.create({
    data: {
      instrumentId: overrides.instrumentId,
      userId: overrides.userId,
      side: overrides.side ?? "BUY",
      type,
      status: orderStatusOf(overrides, type),
      timeInForce: overrides.timeInForce ?? "GTC",
      size: overrides.size ?? 10,
      price: orderPriceArsOf(overrides, type),
      ...orderExecutionFieldsOf(overrides),
    },
  });
};

export interface TestMarketdataOverrides {
  readonly instrumentId: number;
  /** YYYY-MM-DD */
  readonly date?: string;
  readonly highArs?: string;
  readonly lowArs?: string;
  readonly openArs?: string;
  /** Close: el precio de referencia. Requerido. */
  readonly closeArs: string;
  readonly previousCloseArs?: string;
}

/**
 * Vela de marketdata para fijar el precio de referencia de un instrumento
 * (fixture de precios). Defaults: high/low/open = close, previousClose =
 * close, date 2024-01-02 (posterior al seed para ser "la última").
 */
export const createTestMarketdata = async (
  prisma: PrismaClient,
  overrides: TestMarketdataOverrides,
) =>
  prisma.marketdata.create({
    data: {
      instrumentId: overrides.instrumentId,
      date: new Date(overrides.date ?? "2024-01-02"),
      high: overrides.highArs ?? overrides.closeArs,
      low: overrides.lowArs ?? overrides.closeArs,
      open: overrides.openArs ?? overrides.closeArs,
      close: overrides.closeArs,
      previousClose: overrides.previousCloseArs ?? overrides.closeArs,
    },
  });