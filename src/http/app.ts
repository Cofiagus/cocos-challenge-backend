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

/**
 * App Express con los routers montados bajo /api. Sin routers montados,
 * Express responde 404 — el estado "rojo" esperado por los tests funcionales
 * de FASE 2 mientras los slices no existen.
 */
export const buildApp = (routers: readonly Router[]) => {
  const app = express();
  app.use(express.json());
  app.use("/api", ...routers);
  return app;
};