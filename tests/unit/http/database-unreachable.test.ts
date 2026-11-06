// D-03 + base REMOTA — una base inalcanzable también es un 503 reintentable.
//
// Con PostgreSQL local la API podía ignorar los cortes de red; contra una base
// remota son el fallo más probable. Prisma P1001 (no se llega al servidor),
// P1008 (timeout de operación), P1017 (el servidor cerró la conexión), los
// SQLSTATE de la clase 08 (`connection_exception`) y `57P01` (`admin_shutdown`)
// ya NO pueden responder 500: el pedido es válido y reintentarlo lo resuelve.
//
// La clasificación se apoya en la de contención que ya existía
// (`isTemporaryContentionError`, que sigue reconociendo todo lo anterior) y
// agrega el predicado específico `isDatabaseUnreachableError`, que es el que
// elige el MENSAJE del 503: "saturada" (la base está) vs "no disponible" (la
// base no está). El status y el código son los mismos.
//
// Las formas replican los errores reales: `pg` pone el SQLSTATE en `code`,
// Prisma envuelve el fallo de un `$executeRaw` en `P2010` con
// `meta: { code: "08006" }` y los errores de conexión de Prisma traen `meta`
// con host/puerto.

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
  isDatabaseUnreachableError,
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
 * falla la base: sin `try/catch` en el router, el `reject` llega al manejador
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

/** Casos de base inalcanzable: la forma del error, no el mensaje. */
const UNREACHABLE_CASES: ReadonlyArray<readonly [string, () => unknown]> = [
  [
    "P1001 (no se puede alcanzar el servidor) sin `meta`",
    () => errorWithCode("Can't reach database server at db.remote:5432", "P1001"),
  ],
  [
    "P1001 con `meta` de host/puerto (forma de Prisma)",
    () =>
      errorWithMeta(
        "Can't reach database server at db.remote:5432",
        "P1001",
        { database_host: "db.remote", database_port: 5432 },
      ),
  ],
  [
    "P1008 (timeout de operación)",
    () => errorWithCode("Operations timed out after 15.00s", "P1008"),
  ],
  [
    "P1017 (el servidor cerró la conexión)",
    () =>
      errorWithCode(
        "Server has closed the connection.",
        "P1017",
      ),
  ],
  [
    "SQLSTATE 08006 (connection_failure) en `code`",
    () =>
      errorWithCode(
        "connection to server at \"db.remote\", port 5432 failed",
        "08006",
      ),
  ],
  [
    "SQLSTATE 08001 (sqlclient_unable_to_establish_sqlconnection)",
    () => errorWithCode("could not connect to server", "08001"),
  ],
  [
    "SQLSTATE 08P01 (clase 08 no numérica)",
    () => errorWithCode("protocol violation", "08P01"),
  ],
  [
    "SQLSTATE 57P01 (admin_shutdown)",
    () => errorWithCode("terminating connection due to administrator command", "57P01"),
  ],
  [
    "P2010 con el SQLSTATE anidado en `meta` ($executeRaw)",
    () =>
      errorWithMeta("Raw query failed.", "P2010", {
        code: "08006",
        message: "connection to server was lost",
      }),
  ],
  [
    "SQLSTATE anidado en `cause`",
    () =>
      Object.assign(new Error("Failed to connect."), {
        code: "P1001",
        cause: errorWithCode("connection reset by peer", "08006"),
      }),
  ],
];

describe("isDatabaseUnreachableError — clasificación pura", () => {
  it.each(UNREACHABLE_CASES)("%s ⇒ base inalcanzable", (_label, build) => {
    expect(isDatabaseUnreachableError(build())).toBe(true);
  });

  it.each(UNREACHABLE_CASES)(
    "%s ⇒ también es falla temporal de la base (predicado histórico)",
    (_label, build) => {
      expect(isTemporaryContentionError(build())).toBe(true);
    },
  );

  const notUnreachableCases: ReadonlyArray<readonly [string, unknown]> = [
    ["error inesperado", new Error("boom")],
    ["string arbitrario", "boom"],
    ["objeto sin message ni code", {}],
    ["null", null],
    ["número", 42],
    // Contención: la base está, no es "inalcanzable" (aunque sí es 503).
    ["SQLSTATE 57014 (statement_timeout)", errorWithCode("timeout", "57014")],
    ["P2024 (timeout del pool)", errorWithCode("Timed out fetching", "P2024")],
    // Un código de Prisma que NO es de conexión no se reintenta.
    ["P2002 (violación de UNIQUE)", errorWithCode("Unique constraint", "P2002")],
    // Un prefijo de dos dígitos que no es un SQLSTATE completo no clasifica.
    ["código de 2 caracteres `08`", errorWithCode("boom", "08")],
  ];

  it.each(notUnreachableCases)("%s ⇒ NO es base inalcanzable", (_label, error) => {
    expect(isDatabaseUnreachableError(error)).toBe(false);
  });
});

describe("manejador central — base inalcanzable ⇒ 503 con Retry-After", () => {
  const unavailable = databaseUnavailableError("unreachable");
  const saturated = databaseUnavailableError();
  const expectedBody = {
    error: { code: API_ERROR_CODES.DATABASE_UNAVAILABLE, message: unavailable.message },
  };

  it("el 503 de base inalcanzable comparte status y código, con mensaje propio", () => {
    expect(unavailable.status).toBe(503);
    expect(unavailable.code).toBe(API_ERROR_CODES.DATABASE_UNAVAILABLE);
    expect(unavailable.message).not.toBe(saturated.message);
  });

  it.each(
    UNREACHABLE_CASES.filter(([label]) => !label.startsWith("SQLSTATE anidado")),
  )(
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
        // El detalle (código, host, puerto) no viaja al cliente.
        for (const leak of ["P1001", "P1008", "P1017", "08006", "57P01", "5432"]) {
          expect(res.text).not.toContain(leak);
        }
        // ...pero sí queda en stderr para diagnóstico, con la causa correcta.
        expect(stderrText(stderrWrite)).toContain("base inalcanzable");
        expect(stderrText(stderrWrite)).not.toContain("base saturada");
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it("un error que NO es de conexión sigue siendo 500 sin Retry-After", async () => {
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

  it("una violación de UNIQUE (P2002) sigue siendo 500: no se reintenta", async () => {
    const stderrWrite = spyOnStderr();
    try {
      const res = await request(
        appFailingWith(errorWithCode("Unique constraint failed", "P2002")),
      ).get(PORTFOLIO_PATH);

      expect(res.status).toBe(500);
      expect(res.headers[RETRY_AFTER_HEADER.toLowerCase()]).toBeUndefined();
      expect(ApiErrorBodySchema.parse(res.body).error.code).toBe(
        API_ERROR_CODES.INTERNAL_ERROR,
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("la contención conserva su mensaje: el predicado específico corre primero", async () => {
    const stderrWrite = spyOnStderr();
    try {
      const res = await request(
        appFailingWith(
          errorWithCode(
            "canceling statement due to statement timeout",
            "57014",
          ),
        ),
      ).get(PORTFOLIO_PATH);

      expect(res.status).toBe(503);
      expect(ApiErrorBodySchema.parse(res.body)).toEqual({
        error: {
          code: API_ERROR_CODES.DATABASE_UNAVAILABLE,
          message: saturated.message,
        },
      });
      expect(stderrText(stderrWrite)).toContain("base saturada");
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
