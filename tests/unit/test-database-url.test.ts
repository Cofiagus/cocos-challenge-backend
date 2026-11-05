import {
  databaseUrlForTestName,
  setTestDatabaseUrl,
} from "../helpers/test-database-url.js";

describe("test database URL configuration", () => {
  const previousTestDatabaseUrl = process.env["TEST_DATABASE_URL"];
  const previousDatabaseUrl = process.env["DATABASE_URL"];

  afterEach(() => {
    if (previousTestDatabaseUrl === undefined) {
      delete process.env["TEST_DATABASE_URL"];
    } else {
      process.env["TEST_DATABASE_URL"] = previousTestDatabaseUrl;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env["DATABASE_URL"];
    } else {
      process.env["DATABASE_URL"] = previousDatabaseUrl;
    }
  });

  it("derives suite-specific DB names while preserving host and options", () => {
    process.env["TEST_DATABASE_URL"] =
      "postgresql://test:test@example.invalid:5432/integration?sslmode=require";

    expect(databaseUrlForTestName("cocos_challenge_read")).toBe(
      "postgresql://test:test@example.invalid:5432/cocos_challenge_read?sslmode=require",
    );
  });

  it("sets DATABASE_URL only to the derived test database", () => {
    process.env["TEST_DATABASE_URL"] =
      "postgresql://test:test@example.invalid:5432/integration";

    expect(setTestDatabaseUrl("cocos_challenge_cancel")).toBe(
      "postgresql://test:test@example.invalid:5432/cocos_challenge_cancel",
    );
    expect(process.env["DATABASE_URL"]).toBe(
      "postgresql://test:test@example.invalid:5432/cocos_challenge_cancel",
    );
  });

  it("rejects database names that could alter reset SQL", () => {
    process.env["TEST_DATABASE_URL"] =
      "postgresql://test:test@example.invalid:5432/integration";

    expect(() => databaseUrlForTestName("integration; DROP DATABASE app")).toThrow(
      "Nombre de base de test inválido.",
    );
  });

  it("requires an explicit test database URL", () => {
    delete process.env["TEST_DATABASE_URL"];

    expect(() => databaseUrlForTestName("cocos_challenge_test")).toThrow(
      "TEST_DATABASE_URL no definida; configurá .env.test.",
    );
  });
});
