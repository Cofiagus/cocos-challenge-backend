// Configuración de arranque del proceso (T4.c/T4.e) — validada ANTES de
// escuchar en un puerto.
//
// Por qué existe: `Number(process.env["PORT"] ?? "3000")` devuelve NaN con
// `PORT=abc` y `server.listen(NaN)` lanza un RangeError SÍNCRONO que no pasa
// por `server.on("error")`: el proceso moría con un stack opaco en vez de un
// mensaje accionable. Acá todo error de configuración sale como
// RuntimeConfigError con el remedio en el texto, y src/index.ts lo traduce a
// stderr + exit 1.
//
// HOST es configurable (decisión Q5=A) con default loopback: la API no tiene
// autenticación, así que bindear a 0.0.0.0 tiene que ser una decisión
// explícita del operador, nunca el default.

/** Host por defecto: loopback (Q5=A). `listen(port)` sin host bindea 0.0.0.0. */
export const DEFAULT_HOST = "127.0.0.1";

/** Puerto por defecto cuando `PORT` no está definida. */
export const DEFAULT_PORT = 3000;

/** Configuración ya validada que consume src/index.ts. */
export interface RuntimeConfig {
  readonly port: number;
  readonly host: string;
  /**
   * URL validada; el cliente Prisma la lee de process.env por su cuenta
   * (singleton lazy). Acá sólo se garantiza que existe y tiene forma de URL
   * de Postgres antes de aceptar tráfico.
   */
  readonly databaseUrl: string;
}

/** Error de configuración: mensaje accionable, sin stack interno. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

/** `PORT` entero en 1..65535; ausente ⇒ DEFAULT_PORT. */
const parsePort = (raw: string | undefined): number => {
  const text = (raw ?? String(DEFAULT_PORT)).trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new RuntimeConfigError(
      `PORT inválido: "${text}". Se espera un entero entre 1 y 65535 (p. ej. PORT=3000).`,
    );
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new RuntimeConfigError(
      `PORT fuera de rango: ${port}. Se espera un entero entre 1 y 65535.`,
    );
  }
  return port;
};

/** `HOST` no vacío; ausente ⇒ DEFAULT_HOST. */
const parseHost = (raw: string | undefined): string => {
  const host = (raw ?? DEFAULT_HOST).trim();
  if (host === "") {
    throw new RuntimeConfigError(
      `HOST vacío. Omitilo para el default ${DEFAULT_HOST}, o pasá una interfaz (p. ej. HOST=0.0.0.0).`,
    );
  }
  return host;
};

/** `DATABASE_URL` presente y con esquema postgres/postgresql. */
const parseDatabaseUrl = (raw: string | undefined): string => {
  const url = (raw ?? "").trim();
  if (url === "") {
    throw new RuntimeConfigError(
      "DATABASE_URL no definida: copiá .env.example a .env (o exportá DATABASE_URL) antes de arrancar.",
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new RuntimeConfigError(
      "DATABASE_URL inválida: se espera una URL postgresql:// (o postgres://) con usuario, host, puerto y base.",
    );
  }
  return url;
};

/**
 * Lee y valida la configuración del proceso. `env` es inyectable para
 * testear sin tocar process.env.
 */
export const loadRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig => ({
  port: parsePort(env["PORT"]),
  host: parseHost(env["HOST"]),
  databaseUrl: parseDatabaseUrl(env["DATABASE_URL"]),
});
