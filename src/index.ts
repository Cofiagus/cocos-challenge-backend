// Entry del servidor HTTP — orquestador/integrador (la composición vive en
// src/http/server.ts). Carga .env y escucha en PORT; el arranque queda
// verificado con un request real contra un endpoint de lectura.
import "dotenv/config";
import { serverApp } from "./http/server.js";

const port = Number(process.env["PORT"] ?? "3000");

const server = serverApp.listen(port, () => {
  console.log(`✓ cocos-challenge-backend escuchando en http://localhost:${port}`);
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
