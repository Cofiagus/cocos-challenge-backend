// Runtime de composición (T4.a-e) — tests SIN DB.
//
// Cubre lo que la suite funcional no puede: la app se compone con deps FALSAS
// (sin DATABASE_URL), /health es liveness puro (200 con la base caída) y
// /health/ready es readiness real (503 cuando el chequeo falla). Además,
// fail-fast de PORT/DATABASE_URL y default loopback de HOST.

import request from "supertest";
import { createServerApp } from "../../../src/http/server.js";
import type { ServerAppDeps } from "../../../src/http/server.js";
import type {
  CreateOrderResult,
  OrderRecord,
  TransactionContext,
} from "../../../src/contracts/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../../../src/domain/ports/index.js";
import {
  RuntimeConfigError,
  loadRuntimeConfig,
} from "../../../src/lib/runtime-config.js";

const USER_ID = 1;
const PORTFOLIO_PATH = `/api/users/${USER_ID}/portfolio`;
const VALID_DATABASE_URL = "postgresql://cocos:secret@127.0.0.1:5433/cocos_challenge";

const fakePortfolioRead: PortfolioReadRepository = {
  userExists: async () => true,
  listSettledMovements: async () => [],
  listRestingOrders: async () => [],
};

const fakeInstruments: InstrumentRepository = {
  findById: async () => null,
  findByIds: async () => [],
  findByTicker: async () => null,
  searchByQuery: async () => [],
};

const fakeMarketdata: MarketdataRepository = {
  getLatestSnapshot: async () => null,
  getLatestSnapshots: async () => [],
};

/** Repos de escritura: alcanza con que cumplan el port (acá no se ejercitan). */
const fakeOrders: OrderRepository = {
  withUserTransaction: async <T>(
    _userId: number,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> => operation({} as TransactionContext),
  createOrder: async (): Promise<CreateOrderResult> => {
    throw new Error("createOrder no usado en este test");
  },
  appendOrderEvent: async (): Promise<never> => {
    throw new Error("appendOrderEvent no usado en este test");
  },
  findById: async (): Promise<OrderRecord | null> => null,
  markFilled: async (): Promise<OrderRecord | null> => null,
  markCancelled: async (): Promise<OrderRecord | null> => null,
};

/** Deps falsas: nada de Prisma ni de red. */
const buildFakeDeps = (
  checkDatabase: () => Promise<void> = async () => undefined,
): ServerAppDeps => ({
  portfolioRead: fakePortfolioRead,
  instruments: fakeInstruments,
  marketdata: fakeMarketdata,
  orders: fakeOrders,
  quotes: { getCurrentQuote: async () => null },
  checkDatabase,
});

/** Corre `scenario` sin DATABASE_URL y restaura el entorno al salir. */
const withoutDatabaseUrl = async (
  scenario: () => Promise<void>,
): Promise<void> => {
  const saved = process.env["DATABASE_URL"];
  delete process.env["DATABASE_URL"];
  try {
    await scenario();
  } finally {
    if (saved !== undefined) {
      process.env["DATABASE_URL"] = saved;
    }
  }
};

describe("composición con deps falsas — T4.a", () => {
  it("createServerApp construye y atiende rutas de /api sin DATABASE_URL", async () => {
    await withoutDatabaseUrl(async () => {
      expect(process.env["DATABASE_URL"]).toBeUndefined();

      const app = createServerApp(buildFakeDeps());

      await request(app).get(PORTFOLIO_PATH).expect(200);
      await request(app).get("/health").expect(200);
    });
  });

  it("importar la instancia por defecto no exige DATABASE_URL ni crea el cliente", async () => {
    await withoutDatabaseUrl(async () => {
      jest.resetModules();
      const serverModule = await import("../../../src/http/server.js");

      // Los repos reales son perezosos: la app se arma, el 200 de /health no
      // toca Prisma y por lo tanto no hace falta la URL de la base.
      await request(serverModule.serverApp).get("/health").expect(200);
      await request(serverModule.serverApp)
        .get(PORTFOLIO_PATH)
        .expect((res) => {
          // Sin base, la ruta de /api falla en el handler: 500 del contrato,
          // nunca un crash del proceso ni un 404 de composición.
          expect([500, 503]).toContain(res.status);
        });
    });
  });
});

describe("probes de salud — T4.b", () => {
  it("/health ⇒ 200 con la base caída y sin consultarla", async () => {
    const checkDatabase = jest.fn(async (): Promise<void> => {
      throw new Error("la base no responde");
    });
    const app = createServerApp(buildFakeDeps(checkDatabase));

    const res = await request(app).get("/health").expect(200);

    expect(res.body).toEqual({ status: "ok" });
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("/health/ready ⇒ 200 cuando SELECT 1 responde", async () => {
    const checkDatabase = jest.fn(async (): Promise<void> => undefined);
    const app = createServerApp(buildFakeDeps(checkDatabase));

    const res = await request(app).get("/health/ready").expect(200);

    expect(res.body).toEqual({ status: "ready", database: "up" });
    expect(checkDatabase).toHaveBeenCalledTimes(1);
  });

  it("/health/ready ⇒ 503 cuando la DB no responde, sin filtrar el error", async () => {
    const app = createServerApp(
      buildFakeDeps(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
      }),
    );

    const res = await request(app).get("/health/ready").expect(503);

    expect(res.body).toEqual({ status: "unavailable", database: "down" });
    expect(res.text).not.toContain("ECONNREFUSED");
    expect(res.text).not.toContain("5433");
  });

  it("los probes quedan montados ANTES del 404: /api sigue con su contrato", async () => {
    const app = createServerApp(buildFakeDeps());

    const health = await request(app).get("/health").expect(200);
    expect(health.headers["content-type"]).toMatch(/^application\/json/);

    const missing = await request(app).get("/api/nope").expect(404);
    expect(missing.body).toEqual({
      error: { code: "NOT_FOUND", message: "Ruta inexistente." },
    });

    // El prefijo de la API no se come a los probes: /api/health no existe.
    await request(app).get("/api/health").expect(404);
  });
});

describe("fail-fast de configuración — T4.c/T4.e", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PORT: "3001",
    HOST: "127.0.0.1",
    DATABASE_URL: VALID_DATABASE_URL,
  };

  it("PORT inválido ⇒ RuntimeConfigError accionable (no NaN)", () => {
    const load = () => loadRuntimeConfig({ ...baseEnv, PORT: "abc" });

    expect(load).toThrow(RuntimeConfigError);
    expect(load).toThrow(/PORT inválido.*1 y 65535/);
    expect(load).not.toThrow(RangeError);
  });

  it("PORT fuera de rango ⇒ error de configuración", () => {
    expect(() => loadRuntimeConfig({ ...baseEnv, PORT: "70000" })).toThrow(
      /PORT fuera de rango/,
    );
    expect(() => loadRuntimeConfig({ ...baseEnv, PORT: "0" })).toThrow(
      /PORT fuera de rango/,
    );
  });

  it("defaults: PORT 3000 y HOST loopback (Q5=A)", () => {
    const config = loadRuntimeConfig({ DATABASE_URL: VALID_DATABASE_URL });

    expect(config).toEqual({
      port: 3000,
      host: "127.0.0.1",
      databaseUrl: VALID_DATABASE_URL,
    });
  });

  it("HOST es configurable por entorno", () => {
    expect(loadRuntimeConfig({ ...baseEnv, HOST: "0.0.0.0" }).host).toBe(
      "0.0.0.0",
    );
    expect(() => loadRuntimeConfig({ ...baseEnv, HOST: "  " })).toThrow(
      /HOST vacío/,
    );
  });

  it("DATABASE_URL ausente o con esquema inválido ⇒ falla al arrancar", () => {
    expect(() => loadRuntimeConfig({ PORT: "3000" })).toThrow(
      /DATABASE_URL no definida/,
    );
    expect(() =>
      loadRuntimeConfig({ PORT: "3000", DATABASE_URL: "mysql://x/y" }),
    ).toThrow(/DATABASE_URL inválida/);
  });
});
