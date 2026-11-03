// Composición de la app HTTP — scaffolding inicial.
//
// Cada slice HTTP (portfolio, instruments, orders, cancel, transfers) exporta
// una Router factory que recibe sus dependencias (los ports de
// src/domain/ports) inyectadas — así los tests de cada slice componen su
// propia app localmente con fakes y nadie edita un archivo compartido.
// La composición con los routers reales vive en src/http/server.ts y solo la
// toca la capa de composición.

import express from "express";
import type { Router } from "express";

/**
 * App Express con los routers montados bajo /api. Sin routers montados,
 * Express responde 404 — el estado "rojo" esperado por los tests funcionales
 * mientras los slices no existen.
 */
export const buildApp = (routers: readonly Router[]) => {
  const app = express();
  app.use(express.json());
  // app.use(path, ...routers) con lista VACÍA lanza "requires a middleware
  // function" al importar serverApp (hallado por la suite funcional): sin routers,
  // no se monta nada y Express responde su 404 por defecto.
  if (routers.length > 0) {
    app.use("/api", ...routers);
  }
  return app;
};