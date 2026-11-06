// Contrato de errores HTTP — DECISIONS.md fija
// `{ "error": { "code": string, "message": string } }`.
//
// Los errores de borde (Zod) los responden los routers con `apiErrorBody`.
// Este módulo cubre los que NO tienen handler de dominio: ruta o método
// inexistente, body JSON malformado o demasiado grande (body-parser) y
// cualquier error inesperado. El cliente nunca recibe stack, rutas del disco
// ni mensajes internos: el detalle queda en stderr.

import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { API_ERROR_CODES, apiErrorBody } from "../contracts/index.js";
import {
  RETRY_AFTER_HEADER,
  RETRY_AFTER_SECONDS,
  databaseUnavailableError,
  isDatabaseUnreachableError,
  isTemporaryContentionError,
} from "./shared/edge.js";

/** Límite del body JSON (KB): lo usa `express.json` y el mensaje del 413. */
export const JSON_BODY_LIMIT_KB = 100;

/** `type` que body-parser asigna a un body JSON que no parsea. */
const ENTITY_PARSE_FAILED = "entity.parse.failed";
/** `type` que body-parser asigna a un body que excede el límite. */
const ENTITY_TOO_LARGE = "entity.too.large";

/** Guard de objeto: los errores de Express no siempre son `Error`. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** `type` del error de body-parser (p. ej. `entity.parse.failed`), o null. */
const bodyParserErrorType = (error: unknown): string | null => {
  if (!isRecord(error)) {
    return null;
  }
  const type = error["type"];
  return typeof type === "string" ? type : null;
};

/** Stack en UNA línea para stderr (cada frame separado por " | "). */
const singleLineErrorDetail = (error: unknown): string => {
  const detail =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  return detail.split("\n").join(" | ");
};

/**
 * 404 de ruta o método inexistente. Se registra DESPUÉS de los routers: lo
 * que llega acá no matcheó ningún handler (Express 5 no distingue 404 de
 * ruta contra 405 de método; ambos son "no hay handler").
 */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res
    .status(404)
    .json(apiErrorBody(API_ERROR_CODES.NOT_FOUND, "Ruta inexistente."));
};

/**
 * Responde los errores de body-parser que tienen código propio. Devuelve
 * true si el error era uno de ellos (ya respondido).
 */
const respondBodyParserError = (type: string, res: Response): boolean => {
  if (type === ENTITY_PARSE_FAILED) {
    res
      .status(400)
      .json(
        apiErrorBody(
          API_ERROR_CODES.INVALID_JSON,
          "El body no es JSON válido.",
        ),
      );
    return true;
  }
  if (type === ENTITY_TOO_LARGE) {
    res
      .status(413)
      .json(
        apiErrorBody(
          API_ERROR_CODES.PAYLOAD_TOO_LARGE,
          `El body supera el límite de ${JSON_BODY_LIMIT_KB} KB.`,
        ),
      );
    return true;
  }
  return false;
};

/**
 * 503 del contrato por una falla temporal de PostgreSQL (defecto D-03): mismo
 * body `{error:{code,message}}`, cabecera `Retry-After` y el detalle en
 * stderr. Un timeout de sentencia, un pool agotado o una base inalcanzable no
 * son un bug del pedido: se reintentan, nunca se responden 500.
 */
const respondDatabaseUnavailable = (
  error: unknown,
  res: Response,
  kind: "contention" | "unreachable",
): void => {
  const { status, code, message } = databaseUnavailableError(kind);
  const label = kind === "unreachable" ? "base inalcanzable" : "base saturada";
  process.stderr.write(`[http] ${label}: ${singleLineErrorDetail(error)}\n`);
  res.set(RETRY_AFTER_HEADER, String(RETRY_AFTER_SECONDS));
  res.status(status).json(apiErrorBody(code, message));
};

/**
 * Middleware de error (4 parámetros). Express 5 reenvía acá los `reject` de
 * handlers async, así que este es el único lugar donde termina un fallo que
 * no sea de dominio. Una falla temporal de la base responde 503 reintentable
 * (la base inalcanzable primero: su mensaje es el específico) y el resto, 500
 * con un mensaje genérico: el stack queda en stderr y nada interno viaja al
 * cliente.
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Respuesta ya empezada (p. ej. error a mitad de un stream): no se puede
  // reescribir el contrato; que Express cierre la conexión.
  if (res.headersSent) {
    next(error);
    return;
  }
  const bodyParserType = bodyParserErrorType(error);
  if (bodyParserType !== null && respondBodyParserError(bodyParserType, res)) {
    return;
  }
  // `isTemporaryContentionError` también cubre la base inalcanzable, así que
  // el predicado específico se evalúa ANTES para no perder su mensaje.
  if (isDatabaseUnreachableError(error)) {
    respondDatabaseUnavailable(error, res, "unreachable");
    return;
  }
  if (isTemporaryContentionError(error)) {
    respondDatabaseUnavailable(error, res, "contention");
    return;
  }
  process.stderr.write(
    `[http] error no manejado: ${singleLineErrorDetail(error)}\n`,
  );
  res
    .status(500)
    .json(
      apiErrorBody(API_ERROR_CODES.INTERNAL_ERROR, "Error interno del servidor."),
    );
};
