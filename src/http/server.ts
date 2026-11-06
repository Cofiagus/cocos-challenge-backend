// Composition root de la app HTTP — lo edita sólo la capa de composición.
//
// Lectura (UC-1/UC-2): portfolio + instruments con los repos Prisma reales.
// Envío (UC-3): orders/submitOrder.
// Cancelación y transferencias (UC-4/UC-5): cancel + transfers.
// Salud (T4.b): /health y /health/ready.
//
// `createServerApp(deps)` es la factory: recibe los ports ya construidos, así
// los tests componen la app con fakes o con otra configuración sin arrastrar
// Prisma. `serverApp` es la instancia por defecto con la infraestructura real.
//
// Antes los 4 repos se instanciaban a nivel de módulo y esos constructores
// resuelven `getPrismaClient()` en su default: IMPORTAR este módulo exigía
// DATABASE_URL y creaba el cliente (defecto T4.a). Ahora los repos reales se
// piden a través de `lazyPort`, que los construye con el primer método usado:
// importar la composición no toca la base ni el entorno.

import express from "express";
import type { Express } from "express";
import { buildApp } from "./app.js";
import { buildHealthRouter } from "./health.js";
import { buildPortfolioRouter } from "./portfolio/portfolio-router.js";
import { buildInstrumentsRouter } from "./instruments/instruments-router.js";
import { buildOrdersRouter } from "./orders/orders-router.js";
import { buildCancelRouter } from "./cancel/cancel-router.js";
import { buildTransfersRouter } from "./transfers/transfers-router.js";
import { PrismaInstrumentRepository } from "../infra/prisma/instrument-repository.js";
import { PrismaMarketdataRepository } from "../infra/prisma/marketdata-repository.js";
import { PrismaPortfolioReadRepository } from "../infra/prisma/portfolio-read-repository.js";
import { PrismaOrderRepository } from "../infra/prisma/order-repository.js";
import { YahooInstrumentQuoteSource } from "../infra/yahoo/yahoo-instrument-quote-source.js";
import { getPrismaClient } from "../lib/prisma-client.js";
import type {
  InstrumentQuoteSource,
  InstrumentRepository,
  MarketdataRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../domain/ports/index.js";

/** Todo lo que la app necesita para atender requests (ports + probe de DB). */
export interface ServerAppDeps {
  readonly portfolioRead: PortfolioReadRepository;
  readonly instruments: InstrumentRepository;
  readonly marketdata: MarketdataRepository;
  readonly orders: OrderRepository;
  readonly quotes: InstrumentQuoteSource;
  /** `SELECT 1` para /health/ready: resuelve si la base responde. */
  readonly checkDatabase: () => Promise<void>;
}

/**
 * Port perezoso: el objeto expuesto cumple la interfaz, pero el real (`create`)
 * se construye en el primer acceso a un método suyo. Sirve para que la
 * instancia por defecto no pague la construcción de Prisma al importar el
 * módulo; `bind` conserva el `this` de la clase al invocar el método
 * desacoplado del objeto.
 */
const lazyPort = <T extends object>(create: () => T): T =>
  new Proxy({} as T, {
    get: (_target, property) => {
      const port = create();
      const value: unknown = Reflect.get(port, property);
      return typeof value === "function" ? value.bind(port) : value;
    },
  });

/**
 * App completa: probes de salud en la raíz y API bajo /api.
 *
 * Los probes se montan en una capa EXTERIOR porque `buildApp` termina su stack
 * con el 404 del contrato (`notFoundHandler`): lo que se agregue a esa app
 * después quedaría inalcanzable. Así /health nunca cae en el 404 de /api y las
 * rutas de la API conservan el orden routers → 404 → errorHandler.
 */
export const createServerApp = (deps: ServerAppDeps): Express => {
  const app = express();
  app.use(buildHealthRouter({ checkDatabase: deps.checkDatabase }));
  app.use(
    buildApp([
      buildPortfolioRouter({
        portfolioRead: deps.portfolioRead,
        marketdata: deps.marketdata,
        instruments: deps.instruments,
      }),
      buildInstrumentsRouter({ instruments: deps.instruments, quotes: deps.quotes }),
      // SubmitOrderDeps: el precio de referencia sale de marketdata (repo);
      // MarketdataPriceSource queda para el matching de evolución, no del submit.
      buildOrdersRouter({
        orders: deps.orders,
        portfolioRead: deps.portfolioRead,
        instruments: deps.instruments,
        marketdata: deps.marketdata,
      }),
      buildCancelRouter({ orders: deps.orders }),
      buildTransfersRouter({
        orders: deps.orders,
        portfolioRead: deps.portfolioRead,
        instruments: deps.instruments,
      }),
    ]),
  );
  return app;
};

/** Deps reales: repos Prisma perezosos + Yahoo + `SELECT 1`. */
const createDefaultDeps = (): ServerAppDeps => ({
  portfolioRead: lazyPort(() => new PrismaPortfolioReadRepository()),
  instruments: lazyPort(() => new PrismaInstrumentRepository()),
  marketdata: lazyPort(() => new PrismaMarketdataRepository()),
  orders: lazyPort(() => new PrismaOrderRepository()),
  quotes: new YahooInstrumentQuoteSource(),
  checkDatabase: async () => {
    await getPrismaClient().$queryRaw`SELECT 1`;
  },
});

/** Instancia por defecto que consume src/index.ts (y la suite funcional). */
export const serverApp = createServerApp(createDefaultDeps());
