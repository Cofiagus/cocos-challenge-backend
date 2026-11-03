// Entry de composición para los tests funcionales y el server de desarrollo.
//
// FASE 2 (ahora): stub — ningún router montado, todos los endpoints responden
// 404. Los tests rojos de la Célula D deben fallar POR 404 (o "not
// implemented"), no por errores de setup; este stub lo garantiza.
//
// La FASE 3 monta el router de orders (y el de portfolio/instruments ya
// mergeado); la FASE 4 agrega cancel y transfers. Solo el orquestador y la
// célula integradora de cada fase editan este archivo.

import { buildApp } from "./app.js";

export const serverApp = buildApp([]);