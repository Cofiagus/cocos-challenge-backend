// Entry del servidor HTTP — capa de composición (la app se arma en
// src/http/server.ts). Carga .env y escucha en PORT; el arranque queda
// verificado con un request real contra un endpoint de lectura.
import "dotenv/config";
import { serverApp } from "./http/server.js";

const port = Number(process.env["PORT"] ?? "3000");

serverApp.listen(port, () => {
  console.log(`✓ cocos-challenge-backend escuchando en http://localhost:${port}`);
});