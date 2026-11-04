// Contrato OpenAPI: sincronización con el código (T4d de specs/agentificacion-docs.md).
//
// Qué verifica:
//  D4a — `openapi.json` commiteado == lo que genera `scripts/openapi/build.ts` (nadie edita el JSON a mano).
//  D4b — las rutas del registro == los `router.<verbo>("...")` de `src/http/**` (sin rutas fantasma).
//  D5  — los códigos de error documentados == los que el contrato puede emitir.
//  D5b — la atribución es por operación: SUS responses documentan SUS errorCodes.
//  D6  — los campos de los bodies documentados == los del contrato real (drift de shape).
//  D7  — el espejo de wire de dinero acepta/rechaza EXACTAMENTE lo mismo que el schema real.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_ERROR_CODES,
  ArsInputSchema,
  CreateOrderRequestSchema,
  CreateTransferRequestSchema,
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

describe("contrato OpenAPI", () => {
  it("D4a — openapi.json está sincronizado con el generador", () => {
    const committed = readFileSync(join(ROOT, "openapi.json"), "utf8");
    expect(committed).toBe(serializeOpenApiDocument());
  });

  it("D4b — el registro documenta exactamente las rutas de los routers", () => {
    const documented = OPERATIONS.map(
      (operation) => `${operation.method} ${operation.expressPath}`,
    ).sort();
    expect(documented).toEqual(routerRoutes());
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

  it("D7 — el espejo de wire de dinero equivale al schema real", () => {
    const samples: readonly unknown[] = [
      0, 0.25, 100, -5, 1.005, 100.005, "0.1", "100.50", " 7 ", "0", "-3", "1e3", "abc", "",
      "  ", null, true, [1], { a: 1 }, NaN, Infinity, "NaN", "Infinity", "-Infinity", "12,5",
    ];
    for (const sample of samples) {
      expect({
        value: sample,
        ars: ArsInputSchema.safeParse(sample).success,
        positive: PositiveArsInputSchema.safeParse(sample).success,
      }).toEqual({
        value: sample,
        ars: ArsWireSchema.safeParse(sample).success,
        positive: PositiveArsWireSchema.safeParse(sample).success,
      });
    }
  });
});
