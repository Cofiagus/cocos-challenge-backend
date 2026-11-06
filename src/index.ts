// Entry del servidor HTTP: carga .env, escucha en PORT y cierra ordenadamente
// ante SIGTERM/SIGINT. La composición de la app vive en src/http/server.ts.
import "dotenv/config";
import { serverApp } from "./http/server.js";
import { disconnectPrismaClient } from "./lib/prisma-client.js";

const port = Number(process.env["PORT"] ?? "3000");
// Bind exclusivo a loopback: la API es local y no tiene autenticación, así que
// no debe quedar expuesta en las interfaces de red de la máquina. `listen(port)`
// sin host se bindea a 0.0.0.0 (y ::), que es justo lo que hay que evitar.
const host = "127.0.0.1";
const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = serverApp.listen(port, host, () => {
  console.log(`✓ cocos-challenge-backend escuchando en http://${host}:${port}`);
});

// listen() reporta errores asíncronos (EADDRINUSE y afines) como evento
// 'error' y no como excepción: sin este handler el proceso muere con el
// stack crudo de una uncaughtException en vez de un mensaje accionable.
server.on("error", (error: NodeJS.ErrnoException) => {
  const causa =
    error.code === "EADDRINUSE"
      ? `el puerto ${port} ya está en uso`
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
