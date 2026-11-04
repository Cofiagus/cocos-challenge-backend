// PrismaInstrumentRepository. Implementa
// InstrumentRepository de src/domain/ports (catálogo de GET /instruments
// y resolución de instrumentId de los envíos).
//
// findBy* PUEDEN devolver MONEDA (la API la rechaza con 400 —
// DECISIONS.md); searchByQuery la EXCLUYE (no aparece en búsqueda).

import type { PrismaClient } from "@prisma/client";
import type {
  InstrumentRecord,
  TransactionContext,
} from "../../contracts/index.js";
import type { InstrumentRepository } from "../../domain/ports/index.js";
import { getPrismaClient } from "../../lib/prisma-client.js";
import { mapInstrumentRow } from "./mappers.js";
import { resolveDbExecutor, type DbExecutor } from "./transaction-context.js";

export class PrismaInstrumentRepository implements InstrumentRepository {
  constructor(private readonly client: PrismaClient = getPrismaClient()) {}

  readonly findById = async (
    instrumentId: number,
    tx?: TransactionContext,
  ): Promise<InstrumentRecord | null> => {
    // tx opcional (mismo patrón que PortfolioReadRepository): la resolución
    // del instrumento de un envío se lee DENTRO de la tx de ese envío cuando
    // el caller la abre; cliente root si viene undefined.
    const db: DbExecutor = tx ? resolveDbExecutor(tx) : this.client;
    const row = await db.instrument.findUnique({
      where: { id: instrumentId },
    });
    return row === null ? null : mapInstrumentRow(row);
  };

  readonly findByIds = async (
    instrumentIds: readonly number[],
    tx?: TransactionContext,
  ): Promise<readonly InstrumentRecord[]> => {
    if (instrumentIds.length === 0) {
      // Sin ids no hay consulta que hacer.
      return [];
    }
    const db: DbExecutor = tx ? resolveDbExecutor(tx) : this.client;
    // UNA sola consulta IN. Sin ORDER BY: el port no promete orden; los
    // duplicados de la entrada colapsan en una fila cada uno.
    const rows = await db.instrument.findMany({
      where: { id: { in: [...instrumentIds] } },
    });
    return rows.map(mapInstrumentRow);
  };

  readonly findByTicker = async (
    ticker: string,
    tx?: TransactionContext,
  ): Promise<InstrumentRecord | null> => {
    // Ticker exacto, comparación case-insensitive ("pamp" ≡ "PAMP").
    const db: DbExecutor = tx ? resolveDbExecutor(tx) : this.client;
    const row = await db.instrument.findFirst({
      where: { ticker: { equals: ticker, mode: "insensitive" } },
      orderBy: { id: "asc" },
    });
    return row === null ? null : mapInstrumentRow(row);
  };

  readonly searchByQuery = async (
    query: string,
    limit: number,
  ): Promise<readonly InstrumentRecord[]> => {
    // ILIKE %query% sobre ticker O name, case-insensitive; EXCLUYE
    // MONEDA (DECISIONS.md); ORDER BY ticker determinístico; LIMIT n.
    // (Filas con type/ticker/name NULL —imposibles en el seed— quedan
    // fuera por semántica SQL de NULL: no matchean ILIKE ni el NOT.)
    const rows = await this.client.instrument.findMany({
      where: {
        OR: [
          { ticker: { contains: query, mode: "insensitive" } },
          { name: { contains: query, mode: "insensitive" } },
        ],
        NOT: { type: { equals: "MONEDA", mode: "insensitive" } },
      },
      orderBy: { ticker: "asc" },
      take: limit,
    });
    return rows.map(mapInstrumentRow);
  };
}