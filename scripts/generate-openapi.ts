// Genera `openapi.json` en la raíz del repo a partir de `scripts/openapi/**`.
//
//     npm run openapi
//
// El artefacto se commitea: es el contrato que leen las herramientas (y los agentes).
// No editar `openapi.json` a mano — se pisa. El test `tests/docs/openapi.test.ts` falla si el
// archivo commiteado no coincide con lo que genera este script.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeOpenApiDocument } from "./openapi/build.js";

const target = join(process.cwd(), "openapi.json");
writeFileSync(target, serializeOpenApiDocument(), "utf8");
console.log(`✓ openapi.json generado (${target})`);
