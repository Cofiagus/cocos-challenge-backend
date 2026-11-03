// Reset de la DB de TEST para tests de integración: drop/create →
// `prisma migrate deploy` → db/seed.sql. UNA sola fuente del flujo:
// scripts/test-db-reset.sh (`npm run test:db:reset`), idempotente, sin
// docker — ver el script para los prerequisitos del cluster local.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resea cocos_challenge_test al estado del seed sobre el schema migrado
 * (counts 4/66/11/126 + columnas nuevas). Jest corre con rootDir = repo,
 * así que el path relativo del script es estable.
 */
export const resetTestDatabase = async (): Promise<void> => {
  await execFileAsync("bash", ["scripts/test-db-reset.sh"], {
    cwd: process.cwd(),
  });
};