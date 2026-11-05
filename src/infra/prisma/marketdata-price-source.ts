// MarketdataPriceSource. Implementa el PriceSource de
// src/domain/matching para la evaluación de MARKET/IOC/FOK: el precio de
// referencia es el close de la última fila de marketdata por date del
// instrumento (DECISIONS.md), null si no hay marketdata (NO_PRICE).

import type { FinancialDecimal } from "../../contracts/index.js";
import type { PriceSource } from "../../domain/matching/index.js";
import type { MarketdataRepository } from "../../domain/ports/index.js";

export class MarketdataPriceSource implements PriceSource {
  constructor(private readonly marketdata: Pick<MarketdataRepository, "getLatestSnapshot">) {}

  readonly getReferencePriceArs = async (
    instrumentId: number,
  ): Promise<FinancialDecimal | null> => {
    const snapshot = await this.marketdata.getLatestSnapshot(instrumentId);
    return snapshot === null ? null : snapshot.closeArs;
  };
}