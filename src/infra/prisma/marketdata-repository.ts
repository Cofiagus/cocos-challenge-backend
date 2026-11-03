// PrismaMarketdataRepository. Implementa
// MarketdataRepository de src/domain/ports: el precio de referencia del
// sistema es SIEMPRE la última fila de marketdata por `date` del
// instrumento (DECISIONS.md).
//
// Ambos métodos comparten UNA query raw con DISTINCT ON (la forma canónica
// de PG de "última fila por grupo"): una sola ida a la DB tanto para un
// instrumento como para el batch del portfolio, sin duplicados y sin N+1.
//
// Por qué raw y no findFirst/orderBy: (1) el batch no tiene expresión
// equivalente eficiente en el cliente Prisma sin una query por
// instrumento (N+1); (2) `to_char(date, 'YYYY-MM-DD')` devuelve el texto
// exacto de la fecha sin pasar por Date/zona-horaria (el contrato es el
// string YYYY-MM-DD); (3) el índice marketdata(instrumentid, date DESC)
// sirve al plan.

import { Prisma, type PrismaClient } from "@prisma/client";
import type { MarketdataSnapshot, TransactionContext } from "../../contracts/index.js";
import type { MarketdataRepository } from "../../domain/ports/index.js";
import { getPrismaClient } from "../../lib/prisma-client.js";
import { mapMarketdataRawRow, type MarketdataRawRow } from "./mappers.js";
import { resolveDbExecutor, type DbExecutor } from "./transaction-context.js";

export class PrismaMarketdataRepository implements MarketdataRepository {
  constructor(private readonly client: PrismaClient = getPrismaClient()) {}

  readonly getLatestSnapshot = async (
    instrumentId: number,
    tx?: TransactionContext,
  ): Promise<MarketdataSnapshot | null> => {
    // Batch de uno: una sola forma de resolver "la última fila por date".
    const snapshots = await this.getLatestSnapshots([instrumentId], tx);
    return snapshots[0] ?? null;
  };

  readonly getLatestSnapshots = async (
    instrumentIds: readonly number[],
    tx?: TransactionContext,
  ): Promise<readonly MarketdataSnapshot[]> => {
    if (instrumentIds.length === 0) {
      return [];
    }
    // tx opcional (mismo patrón que PortfolioReadRepository): el precio de
    // referencia que decide el cruce de un envío se lee DENTRO de la tx de
    // ese envío cuando el caller la abre; cliente root si viene undefined.
    const db: DbExecutor = tx ? resolveDbExecutor(tx) : this.client;
    // DISTINCT ON (instrumentid) + ORDER BY instrumentid, date DESC, id DESC:
    // la última fila por date; id DESC como desempate determinístico si
    // existiera más de una vela en la misma fecha.
    // date IS NOT NULL: una fila sin fecha no es un punto de precio (si se
    // colara, el mapper falla ruidosamente por close/previousclose NULL).
    // to_char: el contrato pide YYYY-MM-DD como string.
    const rows = await db.$queryRaw<MarketdataRawRow[]>`
      SELECT DISTINCT ON (m.instrumentid)
        m.instrumentid AS instrumentid,
        to_char(m.date, 'YYYY-MM-DD') AS date,
        m.close AS close,
        m.previousclose AS previousclose
      FROM marketdata m
      WHERE m.instrumentid IN (${Prisma.join(instrumentIds)})
        AND m.date IS NOT NULL
      ORDER BY m.instrumentid, m.date DESC, m.id DESC
    `;
    return rows.map(mapMarketdataRawRow);
  };
}