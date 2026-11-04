// PrismaClient singleton.
//
// Prisma 7 REQUIERE un driver adapter para instanciar PrismaClient (la URL
// del datasource ya no viaja en el cliente generado): usamos
// @prisma/adapter-pg@^7 (major alineada con @prisma/client 7.10.1, decisión
// de integración). La URL sale de DATABASE_URL (.env en runtime, .env.test
// en los tests de integración — la suite la carga con dotenv ANTES del
// primer uso, ver tests/integration/infra/**).
//
// El singleton es LAZY (se crea en el primer getPrismaClient()): un
// PrismaClient leído en la inicialización del módulo congelaría
// process.env.DATABASE_URL antes de que dotenv corra en los tests, porque
// los imports de ES se evalúan antes que el cuerpo del módulo de la suite.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

let singleton: PrismaClient | undefined;

/**
 * Cliente Prisma compartido (una conexión/pool por proceso).
 * Los repositorios de src/infra lo reciben como default de su constructor.
 */
export const getPrismaClient = (): PrismaClient => {
  if (!singleton) {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL no definida: falta .env (runtime) o .env.test (tests).",
      );
    }
    const adapter = new PrismaPg({ connectionString: databaseUrl });
    singleton = new PrismaClient({ adapter });
  }
  return singleton;
};

/**
 * Suelta el pool de conexiones si el cliente llegó a crearse. No-op cuando el
 * proceso nunca tocó la base: instanciar un cliente solo para cerrarlo
 * abriría una conexión al pedo.
 */
export const disconnectPrismaClient = async (): Promise<void> => {
  if (!singleton) return;
  await singleton.$disconnect();
};
