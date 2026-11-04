// Contrato de errores HTTP (T3.8/T3.9) — tests SIN DB.
//
// La app se arma con buildApp y routers con repositorios FALSOS (patrón DI,
// igual que src/http/server.ts pero sin Prisma): acá se verifica el borde
// HTTP, no la persistencia. Los errores de dominio (Zod, 404 de usuario,
// 409, 422) los siguen respondiendo los routers; estos casos cubren los que
// antes caían en el HTML de Express: ruta/método inexistente, JSON roto,
// body demasiado grande y fallo inesperado.

import request from "supertest";
import type { Express } from "express";
import {
  API_ERROR_CODES,
  ApiErrorBodySchema,
} from "../../../src/contracts/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  PortfolioReadRepository,
} from "../../../src/domain/ports/index.js";
import { buildApp } from "../../../src/http/app.js";
import { buildPortfolioRouter } from "../../../src/http/portfolio/portfolio-router.js";

const USER_ID = 1;
const PORTFOLIO_PATH = `/api/users/${USER_ID}/portfolio`;
/** 100 KB es el límite por defecto de express.json(). */
const OVERSIZED_BODY_BYTES = 101 * 1024;

const fakeInstrumentRepository: InstrumentRepository = {
  findById: async () => null,
  findByIds: async () => [],
  findByTicker: async () => null,
  searchByQuery: async () => [],
};

const fakeMarketdataRepository: MarketdataRepository = {
  getLatestSnapshot: async () => null,
  getLatestSnapshots: async () => [],
};

const buildPortfolioReadRepository = (
  userExists: PortfolioReadRepository["userExists"],
): PortfolioReadRepository => ({
  userExists,
  listSettledMovements: async () => [],
  listRestingOrders: async () => [],
});

/** App mínima con UNA ruta GET real (portfolio) y sus deps falsas. */
const buildTestApp = (portfolioRead: PortfolioReadRepository): Express =>
  buildApp([
    buildPortfolioRouter({
      portfolioRead,
      marketdata: fakeMarketdataRepository,
      instruments: fakeInstrumentRepository,
    }),
  ]);

/** Content-Type JSON (con charset) en toda respuesta de error. */
const expectJsonContentType = (res: request.Response): void => {
  expect(res.headers["content-type"]).toMatch(/^application\/json/);
};

const expectErrorBody = (res: request.Response, code: string): void => {
  expectJsonContentType(res);
  const body = ApiErrorBodySchema.parse(res.body);
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
};

describe("contrato de errores HTTP — sin DB", () => {
  const workingApp = buildTestApp(buildPortfolioReadRepository(async () => true));

  it("ruta inexistente ⇒ 404 NOT_FOUND con el contrato JSON", async () => {
    const res = await request(workingApp).get("/api/nope").expect(404);

    expectJsonContentType(res);
    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      error: { code: API_ERROR_CODES.NOT_FOUND, message: "Ruta inexistente." },
    });
  });

  it("método no soportado (PUT sobre una ruta GET) ⇒ 404 NOT_FOUND JSON", async () => {
    const res = await request(workingApp).put(PORTFOLIO_PATH).expect(404);

    expectErrorBody(res, API_ERROR_CODES.NOT_FOUND);
    expect(res.text).not.toContain("Cannot PUT");
  });

  it("body JSON inválido ⇒ 400 INVALID_JSON con el contrato JSON", async () => {
    const res = await request(workingApp)
      .post(PORTFOLIO_PATH)
      .set("Content-Type", "application/json")
      .send("{bad")
      .expect(400);

    expectErrorBody(res, API_ERROR_CODES.INVALID_JSON);
    expect(res.text).not.toContain("SyntaxError");
  });

  it("body > 100 KB ⇒ 413 PAYLOAD_TOO_LARGE con el contrato JSON", async () => {
    const oversizedBody = `{"pad":"${"a".repeat(OVERSIZED_BODY_BYTES)}"}`;

    const res = await request(workingApp)
      .post(PORTFOLIO_PATH)
      .set("Content-Type", "application/json")
      .send(oversizedBody)
      .expect(413);

    expectErrorBody(res, API_ERROR_CODES.PAYLOAD_TOO_LARGE);
    expect(res.text).not.toContain("PayloadTooLargeError");
  });

  it("fallo inesperado ⇒ 500 INTERNAL_ERROR sin stack, mensaje interno ni rutas del disco", async () => {
    const failingApp = buildTestApp(
      buildPortfolioReadRepository(async () => {
        throw new Error("boom");
      }),
    );
    const stderrWrite = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const res = await request(failingApp).get(PORTFOLIO_PATH).expect(500);

      expectErrorBody(res, API_ERROR_CODES.INTERNAL_ERROR);
      // Nada del error original (mensaje, stack, rutas absolutas) se filtra.
      for (const internalDetail of ["boom", " at ", "/home/"]) {
        expect(res.text).not.toContain(internalDetail);
        expect(JSON.stringify(res.body)).not.toContain(internalDetail);
      }
      // El detalle SÍ queda registrado en stderr (con stack, en una línea).
      const stderrOutput = stderrWrite.mock.calls
        .map((call) => String(call[0]))
        .join("");
      expect(stderrOutput).toContain("boom");
      expect(stderrOutput).toContain("at ");
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
