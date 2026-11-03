// Branding del canal de transacción.
//
// El tipo REAL detrás del TransactionContext opaco de contracts es el
// cliente de transacción de Prisma (Prisma.TransactionClient): el que
// entrega $transaction(async (tx) => ...). El opaco existe para que
// dominio/aplicación no importen Prisma; como TransactionContext es una
// interfaz vacía + brand, el paso en una u otra dirección NO puede ser
// verificado por el sistema de tipos y se resuelve con estos casts
// DOCUMENTADOS y locales a infra:
//
//  - brand:   Prisma.TransactionClient  -> TransactionContext (sale de acá)
//  - unbrand: TransactionContext         -> Prisma.TransactionClient
//
// Invariante: NADIE fuera de withUserTransaction construye un
// TransactionContext; todo unbrand es por tanto del cliente de tx que esta
// misma tx abrió (con su pg_advisory_xact_lock). El brand via `as`
// (no `as any`): el opaco es estructuralmente compatible con cualquier
// objeto.

import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "../../lib/prisma-client.js";
import type { TransactionContext } from "../../contracts/index.js";

/**
 * Ejecutor de queries: delegados de modelo + raw que usan los repositorios
 * de lectura. Tanto el cliente raíz (PrismaClient) como el de transacción
 * (Prisma.TransactionClient) satisfacen esta forma, lo que permite que
 * PortfolioReadRepository trate "tx opcional" sin uniones.
 */
export type DbExecutor = Pick<
  Prisma.TransactionClient,
  | "$executeRaw"
  | "$queryRaw"
  | "instrument"
  | "marketdata"
  | "order"
  | "orderEvent"
  | "user"
>;

/** Cast documentado (ver header): Prisma tx → opaco de contracts. */
export const brandTransactionContext = (
  tx: Prisma.TransactionClient,
): TransactionContext => tx as unknown as TransactionContext;

/** Cast inverso documentado (ver header): opaco → Prisma tx. */
export const unbrandTransactionContext = (
  tx: TransactionContext,
): Prisma.TransactionClient => tx as unknown as Prisma.TransactionClient;

/**
 * Ejecutor para los repositorios de lectura: el MISMO tx si la lectura
 * participa de la transacción de envío (validez de la validación de
 * fondos), el cliente raíz si viene undefined.
 */
export const resolveDbExecutor = (tx?: TransactionContext): DbExecutor => {
  if (tx) {
    return unbrandTransactionContext(tx);
  }
  return getPrismaClient();
};