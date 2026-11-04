import { config } from "dotenv";
import { Client } from "pg";

// Humo de toolchain (FASE 0): prueba ts-jest + carga de .env.test + URL de la
// DB de test (cocos_challenge_test, reseteable con `npm run test:db:reset`).
config({ path: ".env.test" });

describe("smoke: base de datos de test", () => {
  it("SELECT 1 contra cocos_challenge_test vía pg", async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("DATABASE_URL no definido — falta .env.test");
    }
    expect(databaseUrl).toContain("cocos_challenge_test");

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query<{ one: number; db: string }>(
        "SELECT 1 AS one, current_database() AS db",
      );
      expect(result.rows[0]?.one).toBe(1);
      expect(result.rows[0]?.db).toBe("cocos_challenge_test");
    } finally {
      await client.end();
    }
  });
});
