// Entry del servidor HTTP: fija la zona horaria del proceso, carga .env,
// valida la configuración, escucha en HOST:PORT y cierra ordenadamente ante
// SIGTERM/SIGINT. La composición de la app vive en src/http/server.ts.
//
// ZONA HORARIA (D-01). `orders.datetime` y `orders.filledAt` son
// `timestamp without time zone`: no llevan offset. @prisma/adapter-pg las
// interpreta como UTC, pero `serializeLocalTimestamp` las re-serializa con los
// getters LOCALES del Date. Con el proceso en ART (UTC−3) eso servía 12:14:20
// donde el seed dice 15:14:20; con Tokio se corría +9 h. Fijar TZ=UTC alinea
// la lectura con la semántica de la columna y hace que la API no dependa de la
// zona del host. En ESM los imports ESTÁTICOS se evalúan antes del cuerpo del
// módulo, por eso los imports de runtime son dinámicos: la asignación tiene
// que correr primero. El único import estático es de tipos (se borra al emitir).
import type { RuntimeConfig } from "./lib/runtime-config.js";

process.env["TZ"] = "UTC";

await import("dotenv/config");
const { serverApp } = await import("./http/server.js");
const { disconnectPrismaClient } = await import("./lib/prisma-client.js");
const { loadRuntimeConfig } = await import("./lib/runtime-config.js");

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Config validada ANTES de escuchar: un PORT inválido sale con mensaje
 * accionable y exit 1 en vez del RangeError síncrono de listen(NaN), que
 * además no pasa por server.on("error"). DATABASE_URL también se valida acá
 * (fail-fast): arrancar sin base sólo traslada la falla al primer request.
 */
const loadConfigOrExit = (): RuntimeConfig => {
  try {
    return loadRuntimeConfig();
  } catch (error) {
    const causa = error instanceof Error ? error.message : String(error);
    console.error(`✗ Configuración inválida: ${causa}`);
    process.exit(1);
  }
};

const config = loadConfigOrExit();

const server = serverApp.listen(config.port, config.host, () => {
  console.log(
    `✓ cocos-challenge-backend escuchando en http://${config.host}:${config.port}`,
  );
});

// listen() reporta errores asíncronos (EADDRINUSE y afines) como evento
// 'error' y no como excepción: sin este handler el proceso muere con el
// stack crudo de una uncaughtException en vez de un mensaje accionable.
server.on("error", (error: NodeJS.ErrnoException) => {
  const causa =
    error.code === "EADDRINUSE"
      ? `el puerto ${config.port} ya está en uso`
      : error.message;
  console.error(`✗ No se pudo levantar el servidor: ${causa}`);
  process.exit(1);
});

let isShuttingDown = false;

/**
 * Cierre ordenado: deja de aceptar conexiones, espera las requests en vuelo y
 * recién ahí suelta el pool de Prisma. El timeout con unref() evita que un
 * cierre colgado deje el proceso vivo para siempre (un contenedor que ignora
 * SIGTERM termina en SIGKILL, sin logs ni salida limpia).
 */
const shutdownGracefully = async (signal: NodeJS.Signals): Promise<void> => {
  // SIGTERM seguido de SIGINT (o Ctrl-C repetido) no debe re-entrar: el
  // segundo cierre competiría con el primero por el mismo server y el pool.
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`→ ${signal} recibido: cerrando el servidor…`);
  const forcedExit = setTimeout(() => {
    console.error(
      `✗ El cierre no terminó en ${SHUTDOWN_TIMEOUT_MS / 1000} s: salida forzada.`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forcedExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await disconnectPrismaClient();
    clearTimeout(forcedExit);
    console.log("✓ Servidor cerrado y conexiones a la base liberadas.");
    process.exit(0);
  } catch (error) {
    const causa = error instanceof Error ? error.message : String(error);
    console.error(`✗ Falló el cierre ordenado: ${causa}`);
    process.exit(1);
  }
};

// process.once: la señal que dispara el cierre se desregistra sola, así una
// repetición no vuelve a entrar al handler.
process.once("SIGTERM", () => void shutdownGracefully("SIGTERM"));
process.once("SIGINT", () => void shutdownGracefully("SIGINT"));
