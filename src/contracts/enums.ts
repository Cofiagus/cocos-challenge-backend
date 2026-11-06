// Enums del contrato — ÚNICA fuente de los literales compartidos entre dominio,
// HTTP y DB (cell B mapea los enums de Prisma contra éstos). Valores
// EXACTAMENTE los del seed + DECISIONS.md: sin EXPIRED, sin DAY (fuera de
// alcance del build — ver DECISIONS.md).

import { z } from "zod";

/**
 * side de orders (seed: BUY/SELL/CASH_IN/CASH_OUT). Unión de los dos sides del
 * contrato: no hay schema de los cuatro juntos porque nadie valida la unión
 * (cada ruta valida su mitad); antes existía `OrderSideSchema` sin consumidor.
 */
export type OrderSide = TradingSide | TransferSide;

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

/**
 * eventType de order_events (auditoría append-only — sin EXPIRED). Es un tipo,
 * no un schema: la auditoría la escriben `application` e `infra` con literales
 * ya estrechados y nadie parsea el evento desde el wire (antes existía
 * `OrderEventTypeSchema` sin consumidor de producción).
 */
export type OrderEventType = "ACCEPTED" | "REJECTED" | "FILLED" | "CANCELLED";

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
