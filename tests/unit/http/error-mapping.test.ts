// D-03 — contención/saturación de PostgreSQL: 503 reintentable, nunca 500.
//
// Los routers de escritura mapean los errores de DOMINIO con `toHttpError` y
// reenvían todo lo demás al manejador central; las lecturas (portfolio) no
// atrapan nada. El 503 sale entonces por UN camino — el manejador central —
// con el body uniforme del contrato y la cabecera `Retry-After` que un router
// no podría agregar (arma su respuesta a mano con `res.status().json()`).
//
// Los casos replican las formas REALES: `pg` pone el SQLSTATE en `code`,
// Prisma envuelve el fallo de un `$executeRaw` en `P2010` con
// `meta: { code: "57014" }`, y el pool de `pg` aborta con un `Error` pelado
// ("timeout exceeded when trying to connect") sin `code`.

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
import {
  RETRY_AFTER_HEADER,
  RETRY_AFTER_SECONDS,
  databaseUnavailableError,
  isTemporaryContentionError,
} from "../../../src/http/shared/edge.js";

const USER_ID = 1;
const PORTFOLIO_PATH = `/api/users/${USER_ID}/portfolio`;

/** Error con `code` (forma del driver `pg`: `err.code = SQLSTATE`). */
const errorWithCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

/** Error con `meta` (forma de `PrismaClientKnownRequestError`). */
const errorWithMeta = (
  message: string,
  code: string,
  meta: Record<string, unknown>,
): Error => Object.assign(new Error(message), { code, meta });

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

/**
 * App mínima con la ruta de portfolio, cuyo repositorio de lectura falla como
 * falla la base. Sin `try/catch` en el router, el `reject` llega al manejador
 * central igual que en producción.
 */
const appFailingWith = (error: unknown): Express => {
  const portfolioRead: PortfolioReadRepository = {
    userExists: async () => {
      throw error;
    },
    listSettledMovements: async () => [],
    listRestingOrders: async () => [],
  };
  return buildApp([
    buildPortfolioRouter({
      portfolioRead,
      marketdata: fakeMarketdataRepository,
      instruments: fakeInstrumentRepository,
    }),
  ]);
};

/** Silencia stderr mientras captura lo escrito (el detalle no va al cliente). */
const spyOnStderr = (): jest.SpyInstance =>
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);

const stderrText = (write: jest.SpyInstance): string =>
  write.mock.calls.map((call: readonly unknown[]) => String(call[0])).join("");

describe("isTemporaryContentionError — clasificación pura", () => {
  const contentionCases: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "SQLSTATE 57014 (statement_timeout) en `code`",
      () =>
        errorWithCode(
          "canceling statement due to statement timeout",
          "57014",
        ),
    ],
    [
      "P2028 (transacción interactiva abortada)",
      () =>
        errorWithCode(
          "Transaction API error: Transaction already closed",
          "P2028",
        ),
    ],
    [
      "P2024 (timeout del pool de Prisma)",
      () =>
        errorWithCode(
          "Timed out fetching a new connection from the connection pool",
          "P2024",
        ),
    ],
    [
      "ETIMEDOUT (conexión TCP al servidor)",
      () => errorWithCode("connect ETIMEDOUT 127.0.0.1:55432", "ETIMEDOUT"),
    ],
    [
      "timeout del pool de `pg` sin `code`",
      () => new Error("timeout exceeded when trying to connect"),
    ],
    [
      "P2010 con el SQLSTATE anidado en `meta` ($executeRaw)",
      () =>
        errorWithMeta("Raw query failed.", "P2010", {
          code: "57014",
          message: "canceling statement due to statement timeout",
        }),
    ],
    [
      "SQLSTATE anidado en `cause`",
      () =>
        Object.assign(new Error("Raw query failed."), {
          code: "P2010",
          cause: errorWithCode("canceling statement due to statement timeout", "57014"),
        }),
    ],
  ];

  it.each(contentionCases)("%s ⇒ contención", (_label, build) => {
    expect(isTemporaryContentionError(build())).toBe(true);
  });

  const notContentionCases: ReadonlyArray<readonly [string, unknown]> = [
    ["error inesperado", new Error("boom")],
    ["error de dominio sin código de driver", new Error("Orden no cancelable.")],
    ["objeto sin message ni code", {}],
    ["string arbitrario", "boom"],
    ["null", null],
    ["número", 42],
    // Un código de Prisma que NO es de contención no se reintenta.
    ["P2002 (violación de UNIQUE)", errorWithCode("Unique constraint", "P2002")],
  ];

  it.each(notContentionCases)("%s ⇒ NO es contención", (_label, error) => {
    expect(isTemporaryContentionError(error)).toBe(false);
  });
});

describe("manejador central — contención de PostgreSQL ⇒ 503 con Retry-After", () => {
  const expectedBody = {
    error: {
      code: API_ERROR_CODES.DATABASE_UNAVAILABLE,
      message: databaseUnavailableError().message,
    },
  };

  const httpCases: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "statement_timeout (57014)",
      () =>
        errorWithCode(
          "canceling statement due to statement timeout",
          "57014",
        ),
    ],
    ["P2028", () => errorWithCode("Transaction already closed", "P2028")],
    [
      "timeout del pool (P2024)",
      () => errorWithCode("Timed out fetching a new connection", "P2024"),
    ],
    ["ETIMEDOUT", () => errorWithCode("connect ETIMEDOUT", "ETIMEDOUT")],
    [
      "timeout del pool de `pg` sin code",
      () => new Error("timeout exceeded when trying to connect"),
    ],
  ];

  it.each(httpCases)(
    "%s ⇒ 503 DATABASE_UNAVAILABLE, body exacto y Retry-After",
    async (_label, build) => {
      const stderrWrite = spyOnStderr();
      try {
        const res = await request(appFailingWith(build())).get(PORTFOLIO_PATH);

        expect(res.status).toBe(503);
        expect(res.headers["content-type"]).toMatch(/^application\/json/);
        expect(res.headers[RETRY_AFTER_HEADER.toLowerCase()]).toBe(
          String(RETRY_AFTER_SECONDS),
        );
        // `strictObject`: cualquier campo extra delata un body no uniforme.
        expect(ApiErrorBodySchema.parse(res.body)).toEqual(expectedBody);
        // El detalle de la base no viaja al cliente.
        for (const leak of ["57014", "P2028", "P2024", "ETIMEDOUT", "55432"]) {
          expect(res.text).not.toContain(leak);
        }
        // ...pero sí queda en stderr para diagnóstico.
        expect(stderrText(stderrWrite)).toContain("base saturada");
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it("un error que NO es de contención sigue siendo 500 sin Retry-After", async () => {
    const stderrWrite = spyOnStderr();
    try {
      const res = await request(appFailingWith(new Error("boom"))).get(
        PORTFOLIO_PATH,
      );

      expect(res.status).toBe(500);
      expect(res.headers[RETRY_AFTER_HEADER.toLowerCase()]).toBeUndefined();
      expect(ApiErrorBodySchema.parse(res.body).error.code).toBe(
        API_ERROR_CODES.INTERNAL_ERROR,
      );
      expect(stderrText(stderrWrite)).toContain("boom");
    } finally {
      stderrWrite.mockRestore();
    }
  });
});

describe("cobertura async en Express 5 — el reject llega al manejador, no cuelga", () => {
  it(
    "reject después de un await ⇒ 503 (no queda request pendiente)",
    async () => {
      const stderrWrite = spyOnStderr();
      const portfolioRead: PortfolioReadRepository = {
        userExists: async () => {
          // Un `await` real antes del throw: si Express 5 no atrapara el
          // reject del handler async, la request colgaría hasta el timeout.
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw errorWithCode(
            "canceling statement due to statement timeout",
            "57014",
          );
        },
        listSettledMovements: async () => [],
        listRestingOrders: async () => [],
      };
      try {
        const res = await request(
          buildApp([
            buildPortfolioRouter({
              portfolioRead,
              marketdata: fakeMarketdataRepository,
              instruments: fakeInstrumentRepository,
            }),
          ]),
        )
          .get(PORTFOLIO_PATH)
          .timeout({ response: 2_000, deadline: 2_500 });

        expect(res.status).toBe(503);
        expect(res.headers[RETRY_AFTER_HEADER.toLowerCase()]).toBe(
          String(RETRY_AFTER_SECONDS),
        );
      } finally {
        stderrWrite.mockRestore();
      }
    },
    3_000,
  );

  it(
    "throw síncrono dentro de un handler async ⇒ 503",
    async () => {
      const stderrWrite = spyOnStderr();
      const portfolioRead: PortfolioReadRepository = {
        userExists: () => {
          throw errorWithCode("Transaction already closed", "P2028");
        },
        listSettledMovements: async () => [],
        listRestingOrders: async () => [],
      };
      try {
        const res = await request(
          buildApp([
            buildPortfolioRouter({
              portfolioRead,
              marketdata: fakeMarketdataRepository,
              instruments: fakeInstrumentRepository,
            }),
          ]),
        )
          .get(PORTFOLIO_PATH)
          .timeout({ response: 2_000, deadline: 2_500 });

        expect(res.status).toBe(503);
        expect(ApiErrorBodySchema.parse(res.body).error.code).toBe(
          API_ERROR_CODES.DATABASE_UNAVAILABLE,
        );
      } finally {
        stderrWrite.mockRestore();
      }
    },
    3_000,
  );
});
