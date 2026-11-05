// Idempotencia de CASH (D4, spec §5): decidir si un replay con la MISMA
// idempotencyKey corresponde al movimiento original sin reejecutar centavos.
//
// Dos eras conviven y AMBAS exigen evidencia del evento de ORIGEN:
//  - filas nuevas: `size` guarda el monto exacto (con centavos).
//  - filas históricas: `size` guardó floor(amountArs / 1.00).
//
// El pedido original sólo consta en `metadata.amountArs` del PRIMER evento
// (id asc), que debe ser una DECISIÓN de origen COHERENTE con el estado
// terminal de la fila: FILLED ⇒ ACCEPTED, REJECTED ⇒ REJECTED. NEW/CANCELLED
// no justifican replay con estas reglas ⇒ CONFLICT conservador. Un evento
// posterior con monto no documenta el pedido original. El monto se valida con
// `PositiveArsInputSchema` (única gramática/rango monetario del contrato) y
// debe ser EXACTAMENTE el del retry. La fila debe representar ese monto —
// exacto (nueva) o floor con precio unitario 1.00 (histórica)—, sin reescribir
// size/precios ni agregar eventos.
//
// Sin evidencia suficiente ⇒ CONFLICT (conservador, 409) INCLUSO si `size`
// coincide exactamente con el retry: un test que crea cash sin evento no
// autoriza bypass; se falla antes de adivinar o volver a mover fondos.
//
// La lectura del evento ocurre en la MISMA transacción del claim
// (`db.orderEvent` por orderId), sin un port nuevo.

import { Prisma, type Order } from "@prisma/client";
import {
  FinancialDecimal,
  PositiveArsInputSchema,
} from "../../contracts/index.js";
import { CorruptRowError } from "./corrupt-row.error.js";
import { decimalFromDb } from "./mappers.js";

export type CashIdempotencyOutcome = "IDEMPOTENT_REPLAY" | "IDEMPOTENT_CONFLICT";

const CASH_UNIT_PRICE = new FinancialDecimal("1");

/** Evento de ORIGEN que justifica cada estado terminal de la fila cash. */
const ORIGIN_EVENT_TYPE_BY_TERMINAL_STATUS: Readonly<Record<string, string>> = {
  FILLED: "ACCEPTED",
  REJECTED: "REJECTED",
};

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

/**
 * Evidencia del pedido original: string monetario canónico positivo y dentro
 * del máximo, validado por el MISMO schema del borde. NaN, number JSON,
 * exponente, tercer decimal o basura ⇒ null (nunca se normaliza).
 */
const documentedAmountOf = (
  metadata: Prisma.JsonValue | null,
): FinancialDecimal | null => {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const parsed = PositiveArsInputSchema.safeParse(metadata["amountArs"]);
  return parsed.success ? parsed.data : null;
};

/**
 * Evento de ORIGEN (el primero de la orden) y su monto documentado. El tipo
 * debe ser el que justifica el estado terminal de la fila; un evento posterior
 * con amountArs NO es evidencia del pedido original.
 */
const originalDocumentedAmount = async (
  db: Prisma.TransactionClient,
  row: Order,
): Promise<FinancialDecimal | null> => {
  const expectedOriginEventType =
    row.status === null
      ? undefined
      : ORIGIN_EVENT_TYPE_BY_TERMINAL_STATUS[row.status];
  if (expectedOriginEventType === undefined) {
    return null;
  }
  const origin = await db.orderEvent.findFirst({
    where: { orderId: row.id },
    orderBy: { id: "asc" },
  });
  if (origin === null || origin.eventType !== expectedOriginEventType) {
    return null;
  }
  return documentedAmountOf(origin.metadata);
};

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

  // Primero la evidencia: en igualdad exacta también se exige que el ORIGEN
  // documente el retry (un size truncado puede coincidir y NO ser el pedido).
  const documented = await originalDocumentedAmount(db, row);
  if (documented === null || !documented.equals(requestedAmount)) {
    return "IDEMPOTENT_CONFLICT";
  }

  const unitPrice = row.price === null ? null : decimalFromDb(row.price);
  if (unitPrice === null || !unitPrice.equals(CASH_UNIT_PRICE)) {
    return "IDEMPOTENT_CONFLICT";
  }

  // Nueva: size = monto exacto. Histórica: size = floor(monto documentado).
  return stored.equals(documented) || documented.floor().equals(stored)
    ? "IDEMPOTENT_REPLAY"
    : "IDEMPOTENT_CONFLICT";
};
