import { config } from "dotenv";

// Preserve the app target separately before any test suite overrides it.
config({ path: ".env" });
if (process.env["DATABASE_URL"] && !process.env["APP_DATABASE_URL"]) {
  process.env["APP_DATABASE_URL"] = process.env["DATABASE_URL"];
}
config({ path: ".env.test" });

/** Build one isolated test database URL from the test-only connection URL. */
export const databaseUrlForTestName = (databaseName: string): string => {
  const configuredTestDatabaseUrl = process.env["TEST_DATABASE_URL"];
  if (!configuredTestDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL no definida; configurá .env.test.");
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(databaseName)) {
    throw new Error("Nombre de base de test inválido.");
  }

  const databaseUrl = new URL(configuredTestDatabaseUrl);
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL debe usar el protocolo PostgreSQL.");
  }
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
};

/** Keep every DB-backed test on its isolated DB before Prisma is constructed. */
export const setTestDatabaseUrl = (databaseName: string): string => {
  const databaseUrl = databaseUrlForTestName(databaseName);
  process.env["DATABASE_URL"] = databaseUrl;
  return databaseUrl;
};

/** Set the shared integration-test database for Jest setup. */
export const useDefaultIntegrationTestDatabase = (): void => {
  const configuredTestDatabaseUrl = process.env["TEST_DATABASE_URL"];
  if (configuredTestDatabaseUrl) {
    process.env["DATABASE_URL"] = configuredTestDatabaseUrl;
  }
};
