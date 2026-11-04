// Enums del contrato — ÚNICA fuente de los literales compartidos entre dominio,
// HTTP y DB (cell B mapea los enums de Prisma contra éstos). Valores
// EXACTAMENTE los del seed + DECISIONS.md: sin EXPIRED, sin DAY (fuera de
// alcance del build — ver DECISIONS.md).

import { z } from "zod";

/** side de orders (seed: BUY/SELL/CASH_IN/CASH_OUT). */
export const OrderSideSchema = z.enum([
  "BUY",
  "SELL",
  "CASH_IN",
  "CASH_OUT",
]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

/** side de una orden de trading (POST /orders: BUY/SELL). */
export const TradingSideSchema = z.enum(["BUY", "SELL"]);
export type TradingSide = z.infer<typeof TradingSideSchema>;

/** side de una transferencia (POST /transfers: CASH_IN/CASH_OUT). */
export const TransferSideSchema = z.enum(["CASH_IN", "CASH_OUT"]);
export type TransferSide = z.infer<typeof TransferSideSchema>;

/** type de orders (seed: MARKET/LIMIT). */
export const OrderTypeSchema = z.enum(["MARKET", "LIMIT"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

/** status de orders (seed: NEW/FILLED/CANCELLED/REJECTED — sin EXPIRED). */
export const OrderStatusSchema = z.enum(["NEW", "FILLED", "CANCELLED", "REJECTED"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** Time-In-Force (DECISIONS.md: GTC/IOC/FOK — DAY fuera de alcance). */
export const TimeInForceSchema = z.enum(["GTC", "IOC", "FOK"]);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

/** type de instruments (seed: ACCIONES/MONEDA). */
export const InstrumentTypeSchema = z.enum(["ACCIONES", "MONEDA"]);
export type InstrumentType = z.infer<typeof InstrumentTypeSchema>;

/** eventType de order_events (auditoría append-only — sin EXPIRED). */
export const OrderEventTypeSchema = z.enum([
  "ACCEPTED",
  "REJECTED",
  "FILLED",
  "CANCELLED",
]);
export type OrderEventType = z.infer<typeof OrderEventTypeSchema>;

/**
 * Razones de rechazo/cancelación (DECISIONS.md: guardadas en order_events).
 */
export const OrderRejectionReasonSchema = z.enum([
  "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_POSITION",
  "ZERO_SIZE",
  "NO_PRICE",
  "NO_IMMEDIATE_MATCH",
]);
export type OrderRejectionReason = z.infer<typeof OrderRejectionReasonSchema>;
