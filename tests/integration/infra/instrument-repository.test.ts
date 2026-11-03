// Integración (DB real: cocos_challenge_test) — PrismaInstrumentRepository:
// búsqueda parcial case-insensitive, exclusión de MONEDA, orden
// determinístico, findByTicker exacto.
//
// Prerequisito: `npm run test:db:reset` antes de la suite.

import { config } from "dotenv";

config({ path: ".env.test" });

import { PrismaInstrumentRepository } from "../../../src/infra/prisma/instrument-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import {
  SEED_INSTRUMENT_ARS_ID,
  SEED_INSTRUMENT_PAMP_ID,
} from "../../helpers/fixtures.js";

describe("PrismaInstrumentRepository — catálogo (DB real)", () => {
  const prisma = getPrismaClient();
  const instrumentRepo = new PrismaInstrumentRepository();

  afterAll(async () => {
    // Cierre ordenado del pool del adapter para que el worker de jest termine limpio.
    await prisma.$disconnect();
  });

  it("findByTicker exacto case-insensitive: 'pamp' ≡ 'PAMP' ⇒ id 47; parcial ⇒ null", async () => {
    const lower = await instrumentRepo.findByTicker("pamp");
    expect(lower?.id).toBe(SEED_INSTRUMENT_PAMP_ID);
    expect(lower?.type).toBe("ACCIONES");

    const upper = await instrumentRepo.findByTicker("PAMP");
    expect(upper?.id).toBe(SEED_INSTRUMENT_PAMP_ID);

    // Coincidencia PARCIAL no vale (es exacto, no contains).
    expect(await instrumentRepo.findByTicker("PAM")).toBeNull();
    expect(await instrumentRepo.findByTicker("PAMPA")).toBeNull();
    expect(await instrumentRepo.findByTicker("NO-EXISTE")).toBeNull();
  });

  it("findById ⇒ registro mapeado (findBy* PUEDEN devolver MONEDA; la API la rechaza)", async () => {
    const ars = await instrumentRepo.findById(SEED_INSTRUMENT_ARS_ID);
    expect(ars?.ticker).toBe("ARS");
    expect(ars?.name).toBe("PESOS");
    expect(ars?.type).toBe("MONEDA");
    expect(await instrumentRepo.findById(999999999)).toBeNull();
  });

  it("searchByQuery matchea parcial case-insensitive sobre ticker", async () => {
    const results = await instrumentRepo.searchByQuery("pam", 10);
    expect(results.some((i) => i.id === SEED_INSTRUMENT_PAMP_ID)).toBe(true);
  });

  it("searchByQuery matchea parcial sobre NAME (no ticker)", async () => {
    const results = await instrumentRepo.searchByQuery("holding", 10);
    expect(results.some((i) => i.id === SEED_INSTRUMENT_PAMP_ID)).toBe(true); // "Pampa Holding S.A."
  });

  it("searchByQuery EXCLUYE type='MONEDA' (ARS por ticker y PESOS por name)", async () => {
    const byTicker = await instrumentRepo.searchByQuery("ars", 10);
    expect(byTicker.some((i) => i.id === SEED_INSTRUMENT_ARS_ID)).toBe(false);
    expect(byTicker.every((i) => i.type !== "MONEDA")).toBe(true);

    // "pesos" matchea el NAME del ARS por ILIKE pero MONEDA queda excluido.
    const byName = await instrumentRepo.searchByQuery("pesos", 10);
    expect(byName.some((i) => i.id === SEED_INSTRUMENT_ARS_ID)).toBe(false);
    expect(byName.every((i) => i.type !== "MONEDA")).toBe(true);
  });

  it("searchByQuery respeta limit y es determinístico (mismo orden por ticker)", async () => {
    const first = await instrumentRepo.searchByQuery("a", 5);
    expect(first.length).toBe(5);
    const tickers = first.map((i) => i.ticker);
    const tickersSet = new Set(tickers);
    expect(tickersSet.size).toBe(first.length); // sin duplicados

    // Segunda llamada ⇒ MISMO orden (determinístico).
    const second = await instrumentRepo.searchByQuery("a", 5);
    expect(second.map((i) => i.ticker)).toEqual(tickers);

    // limit mayor ⇒ mismo prefijo de orden (prefijo estable por ORDER BY).
    const bigger = await instrumentRepo.searchByQuery("a", 8);
    expect(bigger.slice(0, 5).map((i) => i.ticker)).toEqual(tickers);
  });
});