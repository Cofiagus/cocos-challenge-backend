// D-04 — el header Idempotency-Key REPETIDO no es una clave válida.
//
// Node une los headers repetidos en `req.headers` como "a, b": una clave
// compuesta que el schema (1..64) aceptaba, así que el defecto sólo se ve en
// `rawHeaders`. Estos tests mandan el request por HTTP REAL (`http.request`
// con el header dos veces) para ejercitar el camino completo
// Express → parseWriteRequest, y comprueban que el 400 no toca NINGÚN port:
// cero lecturas y cero escrituras. El header ÚNICO sigue igual.

import { Decimal } from "decimal.js";
import type { Express } from "express";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApiErrorBodySchema,
  API_ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
  type InstrumentRecord,
  type MarketdataSnapshot,
  type OrderResponse,
} from "../../../src/contracts/index.js";
import { buildApp } from "../../../src/http/app.js";
import { buildOrdersRouter } from "../../../src/http/orders/orders-router.js";
import {
  buildSubmitOrderFakes,
  type SubmitOrderFakes,
} from "../../helpers/fakes/submit-order-fakes.js";

const USER_ID = 1;

/** LIMIT GTC BUY: queda NEW sin precio de referencia ni fondos insuficientes. */
const ORDER_BODY = {
  instrumentId: 1,
  side: "BUY",
  type: "LIMIT",
  timeInForce: "GTC",
  size: 2,
  price: "250.00",
} as const;

const PAMP: InstrumentRecord = {
  id: 1,
  ticker: "PAMP",
  name: "Pampa Holding S.A.",
  type: "ACCIONES",
};

const snapshot: MarketdataSnapshot = {
  instrumentId: 1,
  date: "2023-07-14",
  closeArs: new Decimal("925.85"),
  previousCloseArs: new Decimal("925.85"),
};

/** Fakes de los cuatro ports + app real con el router de orders montado. */
const buildOrdersApp = (): { app: Express; fakes: SubmitOrderFakes } => {
  const fakes = buildSubmitOrderFakes({
    userExists: true,
    instruments: [PAMP],
    snapshot,
    movements: [{ side: "CASH_IN", amountArs: new Decimal("100000.00") }],
  });
  return { app: buildApp([buildOrdersRouter(fakes.deps)]), fakes };
};

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/** POST /api/users/:userId/orders con el Idempotency-Key `keys.length` veces. */
const postOrder = (
  baseUrl: string,
  keys: readonly string[],
): Promise<HttpResult> => {
  const payload = JSON.stringify(ORDER_BODY);
  const headers: Record<string, string | string[]> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
  };
  if (keys.length > 0) {
    // Un array en `headers` hace que Node emita UNA línea por valor.
    headers[IDEMPOTENCY_KEY_HEADER] = [...keys];
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${baseUrl}/api/users/${String(USER_ID)}/orders`,
      { method: "POST", headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
};

/** Corre `run` contra un server efímero de la app (HTTP real, sin DB). */
const withServer = async (
  app: Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> => {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
};

/** El port que crea la orden: su llamada es la PRIMERA escritura del envío. */
const createOrderCalls = (fakes: SubmitOrderFakes): number =>
  fakes.calls.filter((call) => call.method === "createOrder").length;

describe("Idempotency-Key duplicado (D-04) por HTTP real", () => {
  it("dos headers con el mismo nombre ⇒ 400 VALIDATION_ERROR y CERO llamadas a ports", async () => {
    const { app, fakes } = buildOrdersApp();

    await withServer(app, async (baseUrl) => {
      const res = await postOrder(baseUrl, ["primera", "segunda"]);

      expect(res.status).toBe(400);
      const body = ApiErrorBodySchema.parse(res.body);
      expect(body.error.code).toBe(API_ERROR_CODES.VALIDATION_ERROR);
      // El mensaje dice QUÉ está mal: el header viene repetido.
      expect(body.error.message).toContain("repetido");
    });

    // El 400 se resolvió en el borde: ni siquiera se abrió la transacción.
    expect(fakes.calls).toHaveLength(0);
    expect(createOrderCalls(fakes)).toBe(0);
  });

  it("un ÚNICO header ⇒ 201 con la MISMA key (comportamiento sin cambios)", async () => {
    const { app, fakes } = buildOrdersApp();

    await withServer(app, async (baseUrl) => {
      const res = await postOrder(baseUrl, ["orden-123"]);

      expect(res.status).toBe(201);
      expect((res.body as OrderResponse).id).toBe(501);
    });

    expect(createOrderCalls(fakes)).toBe(1);
    expect(fakes.createdDrafts[0]?.idempotencyKey).toBe("orden-123");
  });

  it("un ÚNICO header con coma en el valor NO se confunde con duplicado", async () => {
    const { app, fakes } = buildOrdersApp();

    await withServer(app, async (baseUrl) => {
      const res = await postOrder(baseUrl, ["a, b"]);

      expect(res.status).toBe(201);
    });

    expect(fakes.createdDrafts[0]?.idempotencyKey).toBe("a, b");
  });

  it("sin header ⇒ 201 y la orden se persiste SIN key (sigue siendo opcional)", async () => {
    const { app, fakes } = buildOrdersApp();

    await withServer(app, async (baseUrl) => {
      const res = await postOrder(baseUrl, []);

      expect(res.status).toBe(201);
    });

    expect(fakes.createdDrafts[0]?.idempotencyKey).toBeNull();
  });
});
