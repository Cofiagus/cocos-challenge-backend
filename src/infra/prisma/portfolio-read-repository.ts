// PrismaPortfolioReadRepository — FASE 2 (célula B). Implementa
// PortfolioReadRepository de src/domain/ports (lado de lectura de UC-1 y
// validación de fondos del envío).
//
// UNA query por método (sin N+1): el grouping de posiciones, el costo
// promedio ponderado y las reservas los deriva el DOMINIO PURO
// (src/domain/portfolio) a partir de las listas planas de acá.
//
// tx opcional: si la lectura participa de la transacción de envío
// (validez de la validación de fondos) recibe el MISMO tx; si viene
// undefined usa el cliente raíz (lecturas de GET /portfolio).

import type {
  RestingOrder,
  SettledOrderMovement,
  TransactionContext,
} from "../../contracts/index.js";
import type { PortfolioReadRepository } from "../../domain/ports/index.js";
import { mapRestingOrderRow, mapSettledMovementRow } from "./mappers.js";
import { resolveDbExecutor } from "./transaction-context.js";

export class PrismaPortfolioReadRepository implements PortfolioReadRepository {
  // Sin cliente inyectado: el ejecutor (tx o root) lo resuelve
  // resolveDbExecutor por llamada — el root sale del singleton de src/lib.

  readonly userExists = async (
    userId: number,
    tx?: TransactionContext,
  ): Promise<boolean> => {
    // Proyección mínima (id): resuelve el 404 de usuario también para
    // POST /orders y POST /transfers.
    const db = resolveDbExecutor(tx);
    const row = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return row !== null;
  };

  readonly listSettledMovements = async (
    userId: number,
    tx?: TransactionContext,
  ): Promise<readonly SettledOrderMovement[]> => {
    const db = resolveDbExecutor(tx);
    // Sólo FILLED mueve cash/acciones (docs/database.md §3): incluye
    // CASH_IN/CASH_OUT (cash) y BUY/SELL (posiciones). Orden por id:
    // el mismo orden temporal del dataset para el costo promedio ponderado.
    const rows = await db.order.findMany({
      where: { userId, status: "FILLED" },
      orderBy: { id: "asc" },
    });
    return rows.map(mapSettledMovementRow);
  };

  readonly listRestingOrders = async (
    userId: number,
    tx?: TransactionContext,
  ): Promise<readonly RestingOrder[]> => {
    const db = resolveDbExecutor(tx);
    // Órdenes NEW = reservas derivadas (sin tabla — DECISIONS.md). Si una
    // fila NEW viniera con side CASH_* el mapper falla ruidosamente.
    const rows = await db.order.findMany({
      where: { userId, status: "NEW" },
      orderBy: { id: "asc" },
    });
    return rows.map(mapRestingOrderRow);
  };
}