// Contrato OpenAPI: sincronización con el código.
//
// Qué verifica:
//  D4a — `openapi.json` commiteado == lo que genera `scripts/openapi/build.ts` (nadie edita el JSON a mano).
//  D4b — las rutas del registro == los `router.<verbo>("...")` de `src/http/**` (sin rutas fantasma).
//  D4d — cada operación publicada la SIRVE la app compuesta (detecta prefijos inventados:
//        p. ej. publicar `/api/health` para un probe montado en la raíz).
//  D5  — los códigos de error documentados == los que el contrato puede emitir.
//  D5b — la atribución es por operación: SUS responses documentan SUS errorCodes.
//  D6  — los campos de los bodies documentados == los del contrato real (drift de shape).
//  D7  — el wire de dinero reutilizado del contrato acepta/rechaza EXACTAMENTE lo mismo
//        que el schema real de entrada, en la frontera completa de D1/D3.
//  D8  — el body de la orden equivale al schema real campo por campo.
//  D9  — la cota de columna (MAX_STORED_ARSS) es de ENTRADA: la salida admite agregados mayores.
//  D10 — `quantity` de portfolio es string entero canónico (con negativos legacy).
//  D11 — `OrderResponse.size` discriminado por side: number en trading, string monetario en cash.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { createServerApp } from "../../src/http/server.js";
import type { ServerAppDeps } from "../../src/http/server.js";
import {
  API_ERROR_CODES,
  ArsInputSchema,
  CreateOrderRequestSchema,
  CreateTransferRequestSchema,
  MoneyArsSchema,
  OrderResponseSchema,
  PortfolioPositionSchema,
  PositiveArsInputSchema,
} from "../../src/contracts/index.js";
import { serializeOpenApiDocument } from "../../scripts/openapi/build.js";
import {
  KNOWN_ERROR_CODES,
  OPERATIONS,
  type OperationDoc,
  type ResponseDoc,
} from "../../scripts/openapi/registry.js";
import {
  ArsWireSchema,
  CreateOrderBodySchema,
  CreateTransferBodySchema,
  PositiveArsWireSchema,
} from "../../scripts/openapi/wire.js";

const ROOT = process.cwd();

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    else out.push(child.split("\\").join("/"));
  }
  return out;
};

/** Rutas declaradas en los routers: `router.get("/users/:userId/portfolio", …)`. */
const routerRoutes = (): readonly string[] => {
  const routes: string[] = [];
  for (const file of walk("src/http").filter((path) => path.endsWith(".ts"))) {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const match of source.matchAll(/router\.(get|post|delete|put|patch)\(\s*"([^"]+)"/g)) {
      routes.push(`${match[1] as string} ${match[2] as string}`);
    }
  }
  return routes.sort();
};

const shapeKeys = (schema: unknown): readonly string[] =>
  Object.keys((schema as { readonly shape: Record<string, unknown> }).shape).sort();

/** Navega un nodo del documento OpenAPI generado; falla ruidosamente si falta. */
const objectAt = (parent: unknown, key: string): Record<string, unknown> => {
  if (typeof parent !== "object" || parent === null) {
    throw new TypeError(`El documento OpenAPI generado no es un objeto al pedir "${key}".`);
  }
  const value = (parent as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Falta "${key}" en el documento OpenAPI generado.`);
  }
  return value as Record<string, unknown>;
};

/** Deps falsas: la app se compone sin base ni red (mismo patrón que tests/unit/http/health.test.ts). */
const fakeServerDeps = (): ServerAppDeps => ({
  portfolioRead: {
    userExists: async () => true,
    listSettledMovements: async () => [],
    listRestingOrders: async () => [],
  },
  instruments: {
    findById: async () => null,
    findByIds: async () => [],
    findByTicker: async () => null,
    searchByQuery: async () => [],
  },
  marketdata: {
    getLatestSnapshot: async () => null,
    getLatestSnapshots: async () => [],
  },
  // Los repos de escritura no se ejercitan: sólo importa que la ruta esté montada.
  orders: {
    withUserTransaction: async () => {
      throw new Error("withUserTransaction no usado en la guardia de rutas");
    },
    createOrder: async () => {
      throw new Error("createOrder no usado en la guardia de rutas");
    },
    appendOrderEvent: async () => {
      throw new Error("appendOrderEvent no usado en la guardia de rutas");
    },
    findById: async () => null,
    markFilled: async () => null,
    markCancelled: async () => null,
  },
  quotes: { getCurrentQuote: async () => null },
  checkDatabase: async () => undefined,
});

type ServedResponse = { readonly status: number; readonly body: unknown };

/**
 * Emite una operación publicada contra la app compuesta. Los POST van con body
 * vacío: un 400 de validación prueba que la RUTA existe (lo que se verifica acá),
 * no que el payload sea válido.
 */
const dispatch = async (
  app: ReturnType<typeof createServerApp>,
  method: string,
  path: string,
): Promise<ServedResponse> => {
  const test =
    method === "get"
      ? request(app).get(path)
      : method === "post"
        ? request(app).post(path).send({})
        : method === "delete"
          ? request(app).delete(path)
          : undefined;
  if (test === undefined) {
    throw new Error(`La guardia no sabe emitir ${method.toUpperCase()} ${path}.`);
  }
  const response = await test;
  return { status: response.status, body: response.body };
};

/** Pares (método, path) publicados en el documento generado. */
const publishedOperations = (): readonly { readonly method: string; readonly path: string }[] => {
  const document = JSON.parse(serializeOpenApiDocument()) as Record<string, unknown>;
  return Object.entries(objectAt(document, "paths")).flatMap(([path, item]) =>
    Object.keys(item as Record<string, unknown>).map((method) => ({ method, path })),
  );
};

/** `/api/orders/{orderId}` → `/api/orders/1` (un valor cualquiera: la ruta es lo que importa). */
const concretePath = (path: string): string => path.replace(/\{[^}]+\}/g, "1");

describe("contrato OpenAPI", () => {
  it("D4a — openapi.json está sincronizado con el generador", () => {
    const committed = readFileSync(join(ROOT, "openapi.json"), "utf8");
    expect(committed).toBe(serializeOpenApiDocument());
  });

  it("D4c — la posición de portfolio es strictObject: OpenAPI emite additionalProperties false", () => {
    // E-05: `PortfolioPositionSchema` era el único `z.object` NO estricto del
    // contrato, así que el documento publicado dejaba la posición abierta
    // (cualquier campo extra "valía"). Se verifica sobre el documento GENERADO
    // por `scripts/openapi/build.ts`, no sobre el JSON commiteado (ese se regenera
    // desde el registro de operaciones).
    const document = JSON.parse(serializeOpenApiDocument()) as Record<string, unknown>;
    const operation = objectAt(
      objectAt(objectAt(document, "paths"), "/api/users/{userId}/portfolio"),
      "get",
    );
    const okResponse = objectAt(objectAt(operation, "responses"), "200");
    const media = objectAt(objectAt(okResponse, "content"), "application/json");
    const properties = objectAt(objectAt(media, "schema"), "properties");
    const position = objectAt(objectAt(properties, "positions"), "items");
    expect(position["additionalProperties"]).toBe(false);
    // La respuesta completa ya era estricta: sigue siéndolo.
    expect(objectAt(media, "schema")["additionalProperties"]).toBe(false);
  });

  it("D4b — el registro documenta exactamente las rutas de los routers", () => {
    const documented = OPERATIONS.map(
      (operation) => `${operation.method} ${operation.expressPath}`,
    ).sort();
    expect(documented).toEqual(routerRoutes());
  });

  it("D4d — la app sirve cada operación publicada (ningún prefijo fantasma)", async () => {
    // Guardia de CLASE, no de esta instancia: D4a compara el JSON contra el
    // generador y D4b el registro contra los routers, así que un error COMPARTIDO
    // (prefijar con /api un probe que vive en la raíz) pasaba las dos. Acá la
    // referencia es la app compuesta: se emite cada operación publicada y se
    // compara contra la firma del 404 de routing —la de una ruta que no existe—.
    // Express 5 no conserva el prefijo de montaje en `layer` (queda dentro de un
    // matcher opaco), así que la ruta real se deriva ejercitando la app.
    const app = createServerApp(fakeServerDeps());
    const miss = await dispatch(app, "get", "/ruta-que-no-existe");
    expect(miss).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Ruta inexistente." } },
    });

    const published = publishedOperations();
    // Vaciedad: el documento publica una operación por cada entrada del registro.
    expect(published).toHaveLength(OPERATIONS.length);

    const unserved: string[] = [];
    for (const { method, path } of published) {
      const response = await dispatch(app, method, concretePath(path));
      const isRoutingMiss =
        response.status === miss.status &&
        JSON.stringify(response.body) === JSON.stringify(miss.body);
      if (isRoutingMiss) unserved.push(`${method.toUpperCase()} ${path}`);
    }
    expect(unserved).toEqual([]);
  });

/** Códigos documentados en las responses de UNA operación: viajan en el `example.error.code`. */
const documentedCodesOf = (operation: OperationDoc): readonly string[] =>
  operation.responses.flatMap((response: ResponseDoc) => {
    const example = response.example as
      | { readonly error?: { readonly code?: unknown } }
      | undefined;
    const code = example?.error?.code;
    return typeof code === "string" ? [code] : [];
  });

  it("D5 — los códigos de error documentados son los del contrato", () => {
    const documented = new Set(
      OPERATIONS.flatMap((operation) => [...operation.errorCodes]).map(String),
    );
    const fromContract = new Set<string>(Object.values(API_ERROR_CODES));
    expect([...documented].sort()).toEqual([...fromContract].sort());
    expect([...documented].sort()).toEqual([...KNOWN_ERROR_CODES].sort());

    const json = serializeOpenApiDocument();
    for (const code of fromContract) expect(json).toContain(code);
  });

  it("D5b — por operación: SUS responses documentan exactamente SUS errorCodes", () => {
    // La unión de D5 deja pasar un código que se mude de operación (quede
    // documentado en la operación que ya no lo emite): la atribución se
    // compara por operación.
    for (const operation of OPERATIONS) {
      expect([...documentedCodesOf(operation)].sort()).toEqual(
        [...operation.errorCodes].map(String).sort(),
      );
      for (const code of documentedCodesOf(operation)) {
        expect(Object.values(API_ERROR_CODES)).toContain(code);
      }
    }
  });

  it("D6 — los bodies documentados tienen los mismos campos que el contrato", () => {
    expect(shapeKeys(CreateOrderBodySchema)).toEqual(shapeKeys(CreateOrderRequestSchema));
    expect(shapeKeys(CreateTransferBodySchema)).toEqual(shapeKeys(CreateTransferRequestSchema));
  });

  it("D8 — el espejo del body de la orden equivale al schema real campo por campo", () => {
    // Las reglas cruzadas (XOR instrumentId|ticker, XOR size|amountArs, LIMIT
    // sin price, MARKET con price) viven en `superRefine` y no se espejan: acá
    // se compara cada campo por separado, que es donde una cota o un `nullable`
    // se pierde en silencio.
    const samples: readonly unknown[] = [
      0, 1, 2147483647, 2147483648, 1.5, "5", null, undefined, -1, "100.50", "0", NaN,
    ];
    const fields = ["size", "price", "amountArs", "instrumentId", "ticker"] as const;
    const divergences = fields.flatMap((field) =>
      samples
        .map((sample) => ({
          field,
          value: sample,
          mirror: CreateOrderBodySchema.shape[field].safeParse(sample).success,
          contract: CreateOrderRequestSchema.shape[field].safeParse(sample).success,
        }))
        .filter((comparison) => comparison.mirror !== comparison.contract),
    );
    expect(divergences).toEqual([]);
  });

  it("D7 — el wire de dinero equivale al schema real y aplica la frontera D1/D3", () => {
    // D3: la ENTRADA monetaria es string decimal canónico; el número JSON se
    // rechaza AUNQUE sea pequeño (el parser ya perdió cifras antes del
    // contrato). D1: el máximo es el único definido (`MAX_STORED_ARSS`,
    // NUMERIC(24,2)): max pasa y max + 0.01 no. La gramática rechaza
    // exponente, tercer decimal, ceros iniciales, `+`, espacios y separadores.
    const MAX_STORED = "9999999999999999999999.99";
    const MAX_PLUS_CENT = "10000000000000000000000.00";
    const samples: readonly {
      readonly value: unknown;
      readonly ars: boolean;
      readonly positive: boolean;
    }[] = [
      { value: 0, ars: false, positive: false },
      { value: 1, ars: false, positive: false },
      { value: 0.25, ars: false, positive: false },
      { value: 1.005, ars: false, positive: false },
      { value: 100.005, ars: false, positive: false },
      { value: NaN, ars: false, positive: false },
      { value: Infinity, ars: false, positive: false },
      { value: "0", ars: true, positive: false },
      { value: "0.0", ars: true, positive: false },
      { value: "0.01", ars: true, positive: true },
      { value: "0.1", ars: true, positive: true },
      { value: "100.50", ars: true, positive: true },
      { value: "-5", ars: true, positive: false },
      { value: "-0.01", ars: true, positive: false },
      { value: MAX_STORED, ars: true, positive: true },
      { value: "-9999999999999999999999.99", ars: true, positive: false },
      { value: MAX_PLUS_CENT, ars: false, positive: false },
      { value: "-10000000000000000000000.00", ars: false, positive: false },
      { value: "1e3", ars: false, positive: false },
      { value: "1E3", ars: false, positive: false },
      { value: "1.005", ars: false, positive: false },
      { value: "0.123", ars: false, positive: false },
      { value: "007", ars: false, positive: false },
      { value: "+5", ars: false, positive: false },
      { value: " 7 ", ars: false, positive: false },
      { value: "12,5", ars: false, positive: false },
      { value: "", ars: false, positive: false },
      { value: "  ", ars: false, positive: false },
      { value: "abc", ars: false, positive: false },
      { value: "NaN", ars: false, positive: false },
      { value: "Infinity", ars: false, positive: false },
      { value: "-Infinity", ars: false, positive: false },
      { value: null, ars: false, positive: false },
      { value: true, ars: false, positive: false },
      { value: [1], ars: false, positive: false },
      { value: { a: 1 }, ars: false, positive: false },
    ];
    for (const sample of samples) {
      expect({
        value: sample.value,
        ars: ArsInputSchema.safeParse(sample.value).success,
        positive: PositiveArsInputSchema.safeParse(sample.value).success,
      }).toEqual({
        value: sample.value,
        ars: ArsWireSchema.safeParse(sample.value).success,
        positive: PositiveArsWireSchema.safeParse(sample.value).success,
      });
      expect({
        value: sample.value,
        ars: ArsWireSchema.safeParse(sample.value).success,
        positive: PositiveArsWireSchema.safeParse(sample.value).success,
      }).toEqual({ value: sample.value, ars: sample.ars, positive: sample.positive });
    }
  });

  it("D9 — la cota de columna es de ENTRADA: la salida admite agregados mayores al máximo", () => {
    const MAX_STORED = "9999999999999999999999.99";
    const AGGREGATE_BEYOND_MAX = "100000000000000000000000.00";
    // El máximo de una fila es válido en salida…
    expect(MoneyArsSchema.safeParse(MAX_STORED).success).toBe(true);
    // …y un agregado (cash/patrimonio) puede superarlo SIN ser inválido.
    expect(MoneyArsSchema.safeParse(AGGREGATE_BEYOND_MAX).success).toBe(true);
    // La ENTRADA sí aplica la cota de columna.
    expect(ArsWireSchema.safeParse(AGGREGATE_BEYOND_MAX).success).toBe(false);
    expect(PositiveArsWireSchema.safeParse(AGGREGATE_BEYOND_MAX).success).toBe(false);
    // La salida exige la misma gramática: exactamente 2 decimales, sin -0.00.
    expect(MoneyArsSchema.safeParse("0.00").success).toBe(true);
    expect(MoneyArsSchema.safeParse("-0.00").success).toBe(false);
    expect(MoneyArsSchema.safeParse("123").success).toBe(false);
    expect(MoneyArsSchema.safeParse("123.0").success).toBe(false);
  });

  it("D10 — quantity de portfolio es string entero canónico (con negativos legacy)", () => {
    const quantity = PortfolioPositionSchema.shape.quantity;
    const samples: readonly { readonly value: unknown; readonly ok: boolean }[] = [
      { value: "0", ok: true },
      { value: "10", ok: true },
      { value: "-10", ok: true },
      { value: "2147483648", ok: true },
      { value: "9223372036854775807", ok: true },
      { value: "007", ok: false },
      { value: "+10", ok: false },
      { value: "1e3", ok: false },
      { value: "1.0", ok: false },
      { value: "10 ", ok: false },
      { value: "-0", ok: false },
      { value: "", ok: false },
      { value: 10, ok: false },
      { value: null, ok: false },
    ];
    for (const sample of samples) {
      expect(quantity.safeParse(sample.value).success).toBe(sample.ok);
    }
  });

  it("D11 — OrderResponse.size discriminado por side: number en trading, string monetario en cash", () => {
    const base = {
      id: 1,
      instrumentId: 2,
      type: "MARKET",
      timeInForce: "GTC",
      status: "FILLED",
      price: null,
      filledPrice: null,
      filledAt: null,
      datetime: "2026-11-04T10:27:08",
      reason: null,
    } as const;
    // BUY/SELL: acciones enteras (number) o null.
    expect(OrderResponseSchema.safeParse({ ...base, side: "BUY", size: 5 }).success).toBe(true);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "SELL", size: null }).success,
    ).toBe(true);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "BUY", size: "5" }).success,
    ).toBe(false);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "BUY", size: 1.5 }).success,
    ).toBe(false);
    // CASH_IN/CASH_OUT: monto en pesos como string de EXACTAMENTE 2 decimales.
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "CASH_IN", size: "123.00" }).success,
    ).toBe(true);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "CASH_OUT", size: "0.01" }).success,
    ).toBe(true);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "CASH_IN", size: 123 }).success,
    ).toBe(false);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "CASH_IN", size: "123" }).success,
    ).toBe(false);
    expect(
      OrderResponseSchema.safeParse({ ...base, side: "CASH_IN", size: "123.0" }).success,
    ).toBe(false);
  });
});
