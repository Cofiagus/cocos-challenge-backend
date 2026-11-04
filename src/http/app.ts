// Composición de la app HTTP — scaffolding del orquestador (pre-FASE 2).
//
// Cada slice HTTP (portfolio, instruments, orders, cancel, transfers) exporta
// una Router factory que recibe sus dependencias (los ports de
// src/domain/ports) inyectadas — así los tests de cada célula componen su
// propia app localmente con fakes y nadie edita un archivo compartido.
// La composición con los routers reales vive en src/http/server.ts y solo la
// toca la célula integradora de la fase correspondiente.

import express from "express";
import type { Router } from "express";
import {
  JSON_BODY_LIMIT_KB,
  errorHandler,
  notFoundHandler,
} from "./error-handler.js";

/**
 * App Express con los routers montados bajo /api. Los errores que no tienen
 * handler de dominio (ruta o método inexistente, body JSON inválido o
 * demasiado grande, fallo inesperado) salen con el contrato
 * `{error:{code,message}}`, nunca con el HTML de Express.
 */
export const buildApp = (routers: readonly Router[]) => {
  const app = express();
  app.use(express.json({ limit: `${JSON_BODY_LIMIT_KB}kb` }));
  // app.use(path, ...routers) con lista VACÍA lanza "requires a middleware
  // function" al importar serverApp (hallado por la Célula D): sin routers,
  // no se monta nada y el 404 del contrato lo responde notFoundHandler.
  if (routers.length > 0) {
    app.use("/api", ...routers);
  }
  // Orden: routers → 404 (sin match) → manejador de errores (último).
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};