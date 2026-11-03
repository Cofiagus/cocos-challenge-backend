import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Config del CLI Prisma 7.x (alineado con @prisma/client). El bloque `skills`
// era del CLI Platform v8 (prisma@^8.0.0-rc) y no existe en esta línea.
//
// Prisma 7 NO autocarga .env: la URL del datasource se resuelve ACÁ.
// dotenv config() NO pisa variables ya presentes en el proceso, así que
// scripts que exporten DATABASE_URL (ej. scripts/test-db-reset.sh apuntando
// a cocos_challenge_test) ganan sobre el .env local (cocos_challenge).
config();

const databaseUrl = env("DATABASE_URL");

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL no definida: falta .env o la variable de entorno del script.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    // Migraciones versionadas del repo (prisma/migrations/**).
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
