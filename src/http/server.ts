// Composition root de la app HTTP — SOLO el orquestador y la célula
// integradora de cada fase editan este archivo.
//
// FASE 2 (Célula C): portfolio + instruments con los repos Prisma reales.
// FASE 3 (Célula E): orders/submitOrder — se monta al mergeear esa fase
// (el router aún no existe; mientras, /api/users/:id/orders responde 404,
// que es el estado rojo esperado por la suite funcional de la Célula D).

import { buildApp } from "./app.js";
import { buildPortfolioRouter } from "./portfolio/portfolio-router.js";
import { buildInstrumentsRouter } from "./instruments/instruments-router.js";
import { PrismaInstrumentRepository } from "../infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../infra/prisma/marketdata-repository.js";
import { PrismaPortfolioReadRepository } from "../infra/prisma/portfolio-read-repository.js";

export const serverApp = buildApp([
  buildPortfolioRouter({
    portfolioRead: new PrismaPortfolioReadRepository(),
    marketdata: new PrismaMarketdataRepository(),
    instruments: new PrismaInstrumentRepository(),
  }),
  buildInstrumentsRouter({
    instruments: new PrismaInstrumentRepository(),
    marketdata: new PrismaMarketdataRepository(),
  }),
]);