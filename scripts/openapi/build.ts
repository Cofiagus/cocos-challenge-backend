// Generador del documento OpenAPI 3.1 a partir del registro declarativo + los schemas Zod.
//
// Sin dependencias nuevas: Zod 4 expone `z.toJSONSchema` (JSON Schema 2020-12, que es el dialecto
// que usa OpenAPI 3.1). Los schemas de respuesta se derivan de `src/contracts`, así que el contrato
// documentado no puede divergir de la validación real: `tests/docs/openapi.test.ts` regenera el
// documento y lo compara con `openapi.json`.

import { z } from "zod";
import {
  IDEMPOTENCY_HEADER_SCHEMA,
  OPERATIONS,
  type OperationDoc,
  type ResponseDoc,
} from "./registry.js";

type JsonObject = Record<string, unknown>;

const jsonSchemaOf = (schema: z.ZodTypeAny, io: "input" | "output"): JsonObject => {
  const json = { ...(z.toJSONSchema(schema, { io }) as JsonObject) };
  delete json["$schema"];
  return json;
};

/** Propiedades + requeridos de un esquema objeto (params, query, body). */
const objectParts = (
  schema: z.ZodTypeAny,
  io: "input" | "output",
): { readonly properties: JsonObject; readonly required: readonly string[] } => {
  const json = jsonSchemaOf(schema, io);
  return {
    properties: (json["properties"] ?? {}) as JsonObject,
    required: (json["required"] ?? []) as readonly string[],
  };
};

/** Prefijo bajo el que `buildApp` monta los routers de negocio. */
const API_PREFIX = "/api";

/**
 * `/users/:userId/portfolio` → `/api/users/{userId}/portfolio` (OpenAPI no usa `:param`).
 *
 * El prefijo se agrega SÓLO si la operación se monta bajo `/api`: los probes de
 * infraestructura (`mountedUnderApiPrefix: false`) los sirve `createServerApp` en
 * la raíz, así que publicarlos con el prefijo describiría rutas inexistentes.
 */
const openApiPath = (operation: OperationDoc): string => {
  const path = operation.expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  return operation.mountedUnderApiPrefix === false ? path : `${API_PREFIX}${path}`;
};

const parametersOf = (operation: OperationDoc): readonly JsonObject[] => {
  const parameters: JsonObject[] = [];
  if (operation.params !== undefined) {
    const { properties } = objectParts(operation.params, "input");
    for (const [name, schema] of Object.entries(properties)) {
      parameters.push({ name, in: "path", required: true, schema });
    }
  }
  if (operation.query !== undefined) {
    const { properties, required } = objectParts(operation.query, "input");
    for (const [name, schema] of Object.entries(properties)) {
      parameters.push({
        name,
        in: "query",
        required: required.includes(name),
        schema,
      });
    }
  }
  if (operation.idempotencyHeader === true) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      schema: jsonSchemaOf(IDEMPOTENCY_HEADER_SCHEMA, "input"),
      description:
        "Opcional. Misma key + mismo payload devuelve la orden original (201, sin evento nuevo); " +
        "misma key + otro payload → 409.",
    });
  }
  return parameters;
};

const responseObject = (response: ResponseDoc): JsonObject => ({
  description: response.description,
  ...(response.headers === undefined
    ? {}
    : {
        headers: Object.fromEntries(
          response.headers.map((header) => [
            header.name,
            {
              description: header.description,
              schema: jsonSchemaOf(header.schema, "input"),
            },
          ]),
        ),
      }),
  content: {
    "application/json": {
      schema: jsonSchemaOf(response.schema, "output"),
      ...(response.example === undefined ? {} : { example: response.example }),
    },
  },
});

const operationObject = (operation: OperationDoc): JsonObject => {
  // OpenAPI admite UNA respuesta por status: varios errores con el mismo status (dos 400, dos 404)
  // se fusionan en una descripción que lista todas las causas.
  const responses: JsonObject = {};
  for (const response of operation.responses) {
    const key = String(response.status);
    const existing = responses[key] as JsonObject | undefined;
    responses[key] =
      existing === undefined
        ? responseObject(response)
        : {
            ...existing,
            description: `${String(existing["description"])} Alternativa: ${response.description}`,
          };
  }
  return {
    summary: operation.summary,
    description: operation.description,
    operationId: `${operation.method}${openApiPath(operation)
      .replace(/[/{}]/g, "-")
      .replace(/-+$/, "")}`,
    tags: [operation.expressPath.split("/")[1] ?? "root"],
    parameters: parametersOf(operation),
    ...(operation.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchemaOf(operation.body, "input") } },
          },
        }),
    responses,
  };
};

/** Documento OpenAPI 3.1 completo, determinista (sin timestamps: el test compara byte a byte). */
export const buildOpenApiDocument = (): JsonObject => {
  const paths: JsonObject = {};
  for (const operation of OPERATIONS) {
    const path = openApiPath(operation);
    const pathItem = (paths[path] ?? {}) as JsonObject;
    pathItem[operation.method] = operationObject(operation);
    paths[path] = pathItem;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "cocos-challenge-backend",
      version: "1.0.0",
      description:
        "API REST de portfolio, instrumentos, órdenes y transferencias. Dinero: cálculo en Decimal. " +
        "Cambio incompatible (D3): la entrada monetaria es string decimal canónico (los números JSON " +
        "se rechazan) y la salida monetaria es string con exactamente 2 decimales; los agregados " +
        "pueden superar el máximo por fila. Idempotencia por `Idempotency-Key` opcional.",
    },
    servers: [{ url: "http://localhost:3000", description: "Local" }],
    paths,
  };
};

export const serializeOpenApiDocument = (): string =>
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
