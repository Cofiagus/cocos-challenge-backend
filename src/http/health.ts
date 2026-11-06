// Probes de salud (T4.b): liveness y readiness SEPARADAS.
//
// `/health` (liveness) responde 200 siempre y NO toca la base: si el proceso
// puede contestar HTTP, está vivo; un orquestador que reinicia por una DB
// caída sólo consigue perder las requests en vuelo.
// `/health/ready` (readiness) hace `SELECT 1` y traduce a 200/503: es la que
// decide si el tráfico se enruta a esta instancia.
//
// La dependencia entra inyectada (`checkDatabase`) para que el router sea
// testeable sin DB y para que el composition root (src/http/server.ts) sea el
// único que conozca Prisma.

import { Router } from "express";
import type { Request, Response } from "express";

/** Deps del router de salud: sólo el chequeo de base. */
export interface HealthRouterDeps {
  /** Resuelve si `SELECT 1` respondió; rechaza si la base no está disponible. */
  readonly checkDatabase: () => Promise<void>;
}

/** Cuerpo del liveness: 200 si el proceso atiende HTTP. */
const LIVENESS_BODY = { status: "ok" } as const;

/** Cuerpo del readiness cuando `SELECT 1` respondió. */
const READY_BODY = { status: "ready", database: "up" } as const;

/**
 * Cuerpo del 503. Sin detalle del error: el mensaje de un fallo de conexión
 * puede llevar host/puerto de la base y este endpoint es público para el
 * balanceador, no un canal de diagnóstico.
 */
const NOT_READY_BODY = { status: "unavailable", database: "down" } as const;

/**
 * Router con `/health` y `/health/ready`. Se monta en la RAÍZ de la app
 * (antes del 404 que cierra `buildApp`), no bajo `/api`: las probes de
 * infraestructura no son parte de la API pública.
 */
export const buildHealthRouter = (deps: HealthRouterDeps): Router => {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    // Liveness: nunca espera a la base. Un 200 acá con la DB caída es el
    // contrato, no un bug (el 503 lo da /health/ready).
    res.status(200).json(LIVENESS_BODY);
  });

  router.get("/health/ready", async (_req: Request, res: Response) => {
    try {
      await deps.checkDatabase();
    } catch {
      res.status(503).json(NOT_READY_BODY);
      return;
    }
    res.status(200).json(READY_BODY);
  });

  return router;
};
