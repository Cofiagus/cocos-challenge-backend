// Idempotencia de CASH (D4, spec §5): decidir si un replay con la MISMA
// idempotencyKey corresponde al movimiento original sin reejecutar centavos.
//
// Dos eras conviven:
//  - filas nuevas: `size` guarda el monto exacto (con centavos). Igualdad
//    Decimal exacta ⇒ REPLAY.
//  - filas históricas: `size` guardó floor(amountArs / 1.00). El pedido
//    original sólo consta en `metadata.amountArs` del evento de ORIGEN. Se
//    exige evidencia estricta: primer evento (id asc), monto string canónico
//    positivo, precio unitario 1.00 y `size == floor(amount)`; además el monto
//    documentado debe ser EXACTAMENTE el pedido del retry. Sin evidencia
//    suficiente ⇒ CONFLICT (conservador, 409): no se adivina ni se mueven
//    fondos de nuevo.
//
// La lectura del evento ocurre en la MISMA transacción del claim
// (`db.orderEvent` por orderId), sin un port nuevo.

import { Prisma, type Order } from "@prisma/client";
import {
  FinancialDecimal,
  MAX_STORED_ARSS,
} from "../../contracts/index.js";
import { CorruptRowError } from "./corrupt-row.error.js";
import { decimalFromDb } from "./mappers.js";

export type CashIdempotencyOutcome = "IDEMPOTENT_REPLAY" | "IDEMPOTENT_CONFLICT";

/** Gramática estricta de la evidencia: decimal canónico positivo, ≤2 decimales. */
const EVIDENCE_AMOUNT_GRAMMAR = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u;

const CASH_UNIT_PRICE = new FinancialDecimal(1);

/** Monto almacenado de la fila cash; NULL donde el contrato exige valor = corrupción. */
const storedCashAmount = (row: Order): FinancialDecimal => {
  if (row.size === null) {
    throw new CorruptRowError("orders(cash)", "size (monto ARS)");
  }
  const amount = decimalFromDb(row.size);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new CorruptRowError("orders(cash)", `size=${amount.toString()} (monto ARS inválido)`);
  }
  return amount;
};

/** Evidencia del pedido original: string canónico; number/NaN/basura ⇒ null. */
const documentedAmountOf = (
  metadata: Prisma.JsonValue | null,
): FinancialDecimal | null => {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = metadata["amountArs"];
  if (typeof raw !== "string" || !EVIDENCE_AMOUNT_GRAMMAR.test(raw)) {
    return null;
  }
  const amount = new FinancialDecimal(raw);
  if (
    !amount.isFinite() ||
    amount.lessThanOrEqualTo(0) ||
    amount.greaterThan(MAX_STORED_ARSS)
  ) {
    return null;
  }
  return amount;
};

/**
 * Evento de ORIGEN (el primero de la orden) y su monto documentado. Un evento
 * posterior con amountArs NO es evidencia del pedido original.
 */
const originalDocumentedAmount = async (
  db: Prisma.TransactionClient,
  orderId: number,
): Promise<FinancialDecimal | null> => {
  const origin = await db.orderEvent.findFirst({
    where: { orderId },
    orderBy: { id: "asc" },
  });
  return origin === null ? null : documentedAmountOf(origin.metadata);
};

/** La fila histórica debe representar floor(evidencia) a precio unitario 1.00. */
const representsHistoricalFloor = (
  row: Order,
  documented: FinancialDecimal,
  stored: FinancialDecimal,
): boolean =>
  row.price !== null &&
  decimalFromDb(row.price).equals(CASH_UNIT_PRICE) &&
  documented.floor().equals(stored);

/**
 * Replay vs conflicto de un cash con la MISMA key ya reclamada.
 * `requestedAmount` es el monto exacto del retry (ya validado por el borde).
 */
export const cashIdempotencyOutcome = async (
  db: Prisma.TransactionClient,
  row: Order,
  requestedAmount: FinancialDecimal,
): Promise<CashIdempotencyOutcome> => {
  const stored = storedCashAmount(row);
  if (stored.equals(requestedAmount)) {
    return "IDEMPOTENT_REPLAY";
  }

  const documented = await originalDocumentedAmount(db, row.id);
  if (documented === null || !documented.equals(requestedAmount)) {
    return "IDEMPOTENT_CONFLICT";
  }
  return representsHistoricalFloor(row, documented, stored)
    ? "IDEMPOTENT_REPLAY"
    : "IDEMPOTENT_CONFLICT";
};
