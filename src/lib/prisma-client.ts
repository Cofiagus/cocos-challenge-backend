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
 * Dimensionado del pool (T4.d), parametrizable por entorno (base REMOTA).
 *
 * Los defaults son los de siempre y conservan el por qué:
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
 *
 * Contra una base remota la latencia y los cortes cambian el cálculo, así que
 * los tres se pueden pisar con DATABASE_POOL_MAX,
 * DATABASE_CONNECTION_TIMEOUT_MS y DATABASE_STATEMENT_TIMEOUT_MS (ver
 * .env.example). Sin esas variables el comportamiento es el de siempre.
 */
const DEFAULT_POOL_MAX_CONNECTIONS = 10;
const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/** Variables de entorno que parametrizan el pool (una por cada límite). */
const POOL_MAX_ENV = "DATABASE_POOL_MAX";
const POOL_CONNECTION_TIMEOUT_ENV = "DATABASE_CONNECTION_TIMEOUT_MS";
const STATEMENT_TIMEOUT_ENV = "DATABASE_STATEMENT_TIMEOUT_MS";

/** Configuración efectiva del pool que recibe el driver adapter. */
export interface PoolConfig {
  readonly maxConnections: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

/** Entorno leído: `process.env` en runtime, un objeto plano en los tests. */
type EnvSource = Readonly<Record<string, string | undefined>>;

/** Entero positivo canónico: sin signo, sin ceros a la izquierda, sin `.`. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Entero positivo de una variable de entorno; el default SÓLO si no está
 * definida. Un valor definido pero inválido (vacío, `0`, negativo, decimal,
 * con espacios o fuera de rango seguro) FALLA con un mensaje que nombra la
 * variable, el valor recibido y el default: arrancar con un pool distinto al
 * que el operador pidió, en silencio, es peor que no arrancar.
 */
const positiveIntegerFromEnv = (
  env: EnvSource,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!POSITIVE_INTEGER.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(
      `${name} inválida ("${raw}"): se espera un entero positivo; ` +
        `sin definir usa el default ${fallback}.`,
    );
  }
  return value;
};

/** Configuración del pool a partir del entorno (defaults si no hay vars). */
export const resolvePoolConfig = (env: EnvSource = process.env): PoolConfig => ({
  maxConnections: positiveIntegerFromEnv(
    env,
    POOL_MAX_ENV,
    DEFAULT_POOL_MAX_CONNECTIONS,
  ),
  connectionTimeoutMs: positiveIntegerFromEnv(
    env,
    POOL_CONNECTION_TIMEOUT_ENV,
    DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
  ),
  statementTimeoutMs: positiveIntegerFromEnv(
    env,
    STATEMENT_TIMEOUT_ENV,
    DEFAULT_STATEMENT_TIMEOUT_MS,
  ),
});

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
    const pool = resolvePoolConfig();
    const adapter = new PrismaPg({
      connectionString: databaseUrl,
      max: pool.maxConnections,
      connectionTimeoutMillis: pool.connectionTimeoutMs,
      statement_timeout: pool.statementTimeoutMs,
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
