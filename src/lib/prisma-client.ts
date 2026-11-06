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

/**
 * Dimensionado EXPLÍCITO del pool (T4.d). El default del adapter es opaco y
 * sin timeouts: una base caída deja requests colgadas y una query trabada
 * retiene la conexión (y el advisory lock por usuario del submit) sin límite.
 *
 * - max 10: un proceso Node atiende I/O concurrente con pocas conexiones; 10
 *   cubre el paralelismo real de esta API y deja margen bajo el default de
 *   Postgres (100) para varias instancias y para las suites de test.
 * - connectionTimeoutMillis 5000: si no hay conexión en 5 s, fallar rápido.
 *   Es lo que hace que /health/ready devuelva 503 en vez de colgarse cuando
 *   la base no está, y que un request no quede esperando al pool.
 * - statement_timeout 15000: techo por sentencia; una query de más de 15 s en
 *   este dominio es un bug (o un lock retenido), no carga legítima. Evita que
 *   una transacción con advisory lock bloquee al usuario indefinidamente.
 */
const POOL_MAX_CONNECTIONS = 10;
const POOL_CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;

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
    const adapter = new PrismaPg({
      connectionString: databaseUrl,
      max: POOL_MAX_CONNECTIONS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
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
