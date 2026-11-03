// Integración (DB real: cocos_challenge_test) — PrismaMarketdataRepository
// y MarketdataPriceSource: última fila por `date` (precio de referencia),
// null para instrumentos sin marketdata, batch sin duplicados ni N+1.
//
// Prerequisito: `npm run test:db:reset` antes de la suite (closes del seed).

import { config } from "dotenv";

config({ path: ".env.test" });

import { MarketdataPriceSource } from "../../../src/infra/prisma/marketdata-price-source.js";
import { PrismaMarketdataRepository } from "../../../src/infra/prisma/marketdata-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import {
  SEED_INSTRUMENT_BMA_ID,
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
  SEED_INSTRUMENTS_WITHOUT_MARKETDATA,
  SEED_LATEST_MARKETDATA_DATE,
  SEED_REFERENCE_CLOSES,
} from "../../helpers/fixtures.js";

const prisma = getPrismaClient();

afterAll(async () => {
  // Cierre ordenado del pool del adapter para que el worker de jest termine limpio.
  await prisma.$disconnect();
});

describe("PrismaMarketdataRepository — precio de referencia (DB real)", () => {
  const marketdataRepo = new PrismaMarketdataRepository();

  it("getLatestSnapshot(PAMP) ⇒ close 925.85 del 2023-07-14 (ÚLTIMA fila por date)", async () => {
    const snapshot = await marketdataRepo.getLatestSnapshot(SEED_INSTRUMENT_PAMP_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.instrumentId).toBe(SEED_INSTRUMENT_PAMP_ID);
    // fecha como texto YYYY-MM-DD exacto (to_char, sin zona horaria)
    expect(snapshot?.date).toBe(SEED_LATEST_MARKETDATA_DATE);
    expect(snapshot?.closeArs.toFixed(2)).toBe(SEED_REFERENCE_CLOSES.PAMP);
    expect(snapshot?.previousCloseArs).not.toBeNull();
  });

  it("getLatestSnapshot(METR) ⇒ close 229.50 del 2023-07-14", async () => {
    const snapshot = await marketdataRepo.getLatestSnapshot(SEED_INSTRUMENT_METR_ID);
    expect(snapshot?.date).toBe(SEED_LATEST_MARKETDATA_DATE);
    expect(snapshot?.closeArs.toFixed(2)).toBe(SEED_REFERENCE_CLOSES.METR);
  });

  it("instrumentos SIN marketdata (PGR, IRCP, ARS) ⇒ null (NO_PRICE)", async () => {
    for (const instrumentId of SEED_INSTRUMENTS_WITHOUT_MARKETDATA) {
      expect(await marketdataRepo.getLatestSnapshot(instrumentId)).toBeNull();
    }
  });

  it("getLatestSnapshots batch ⇒ UNA fila por instrumento pedido, sin duplicados", async () => {
    const snapshots = await marketdataRepo.getLatestSnapshots([
      SEED_INSTRUMENT_PAMP_ID,
      SEED_INSTRUMENT_METR_ID,
      SEED_INSTRUMENT_BMA_ID,
      ...SEED_INSTRUMENTS_WITHOUT_MARKETDATA, // sin marketdata ⇒ ausentes
    ]);
    // sólo los 3 con marketdata; los sin datos NO aparecen
    expect(snapshots).toHaveLength(3);
    const ids = snapshots.map((s) => s.instrumentId);
    expect(new Set(ids).size).toBe(3); // sin duplicados

    const byId = new Map(snapshots.map((s) => [s.instrumentId, s]));
    expect(byId.get(SEED_INSTRUMENT_PAMP_ID)?.closeArs.toFixed(2)).toBe(
      SEED_REFERENCE_CLOSES.PAMP,
    );
    expect(byId.get(SEED_INSTRUMENT_METR_ID)?.closeArs.toFixed(2)).toBe(
      SEED_REFERENCE_CLOSES.METR,
    );
    expect(byId.get(SEED_INSTRUMENT_BMA_ID)?.closeArs.toFixed(2)).toBe(
      SEED_REFERENCE_CLOSES.BMA,
    );
    expect(byId.get(SEED_INSTRUMENT_PAMP_ID)?.date).toBe(SEED_LATEST_MARKETDATA_DATE);
  });

  it("getLatestSnapshots([]) ⇒ [] sin tocar la DB", async () => {
    expect(await marketdataRepo.getLatestSnapshots([])).toEqual([]);
  });
});

describe("MarketdataPriceSource — getReferencePriceArs (DB real)", () => {
  const marketdataRepo = new PrismaMarketdataRepository();
  const priceSource = new MarketdataPriceSource(marketdataRepo);

  it("precio de referencia = close del latest snapshot (PAMP ⇒ 925.85)", async () => {
    const reference = await priceSource.getReferencePriceArs(SEED_INSTRUMENT_PAMP_ID);
    expect(reference?.toFixed(2)).toBe(SEED_REFERENCE_CLOSES.PAMP);
  });

  it("sin marketdata ⇒ null (NO_PRICE para la evaluación)", async () => {
    for (const instrumentId of SEED_INSTRUMENTS_WITHOUT_MARKETDATA) {
      expect(await priceSource.getReferencePriceArs(instrumentId)).toBeNull();
    }
  });
});