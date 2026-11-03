// Composition root de la app HTTP — lo edita sólo la capa de composición.
//
// Lectura (UC-1/UC-2): portfolio + instruments con los repos Prisma reales.
// Envío (UC-3): orders/submitOrder.
// Cancelación y transferencias (UC-4/UC-5): cancel + transfers.

import { buildApp } from "./app.js";
import { buildPortfolioRouter } from "./portfolio/portfolio-router.js";
import { buildInstrumentsRouter } from "./instruments/instruments-router.js";
import { buildOrdersRouter } from "./orders/orders-router.js";
import { buildCancelRouter } from "./cancel/cancel-router.js";
import { buildTransfersRouter } from "./transfers/transfers-router.js";
import { PrismaInstrumentRepository } from "../infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../infra/prisma/marketdata-repository.js";
import { PrismaPortfolioReadRepository } from "../infra/prisma/portfolio-read-repository.js";
import { PrismaOrderRepository } from "../infra/prisma/order-repository.js";

const portfolioRead = new PrismaPortfolioReadRepository();
const instruments = new PrismaInstrumentRepository();
const marketdata = new PrismaMarketdataRepository();
const orders = new PrismaOrderRepository();

export const serverApp = buildApp([
  buildPortfolioRouter({ portfolioRead, marketdata, instruments }),
  buildInstrumentsRouter({ instruments, marketdata }),
  // SubmitOrderDeps: el precio de referencia sale de marketdata (repo);
  // MarketdataPriceSource queda para el matching de evolución, no del submit.
  buildOrdersRouter({ orders, portfolioRead, instruments, marketdata }),
  buildCancelRouter({ orders }),
  buildTransfersRouter({ orders, portfolioRead, instruments }),
]);
