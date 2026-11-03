// PrismaInstrumentRepository — FASE 2 (célula B). Implementa
// InstrumentRepository de src/domain/ports (catálogo de GET /instruments
// y resolución de instrumentId de los envíos).
//
// findBy* PUEDEN devolver MONEDA (la API la rechaza con 400 —
// DECISIONS.md); searchByQuery la EXCLUYE (no aparece en búsqueda).

import type { PrismaClient } from "@prisma/client";
import type {
  InstrumentRecord,
} from "../../contracts/index.js";
import type { InstrumentRepository } from "../../domain/ports/index.js";
import { getPrismaClient } from "../../lib/prisma-client.js";
import { mapInstrumentRow } from "./mappers.js";

export class PrismaInstrumentRepository implements InstrumentRepository {
  constructor(private readonly client: PrismaClient = getPrismaClient()) {}

  readonly findById = async (
    instrumentId: number,
  ): Promise<InstrumentRecord | null> => {
    const row = await this.client.instrument.findUnique({
      where: { id: instrumentId },
    });
    return row === null ? null : mapInstrumentRow(row);
  };

  readonly findByTicker = async (
    ticker: string,
  ): Promise<InstrumentRecord | null> => {
    // Ticker exacto, comparación case-insensitive ("pamp" ≡ "PAMP").
    const row = await this.client.instrument.findFirst({
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