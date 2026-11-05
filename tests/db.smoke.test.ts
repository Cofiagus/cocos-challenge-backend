import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.test" });

describe("smoke: base de datos de test", () => {
  it("ejecuta SELECT 1 contra TEST_DATABASE_URL vía pg", async () => {
    const databaseUrl = process.env["TEST_DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL no definida — configurar .env.test");
    }
    const expectedDatabaseName = new URL(databaseUrl).pathname.slice(1);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query<{ one: number; db: string }>(
        "SELECT 1 AS one, current_database() AS db",
      );
      expect(result.rows[0]?.one).toBe(1);
      expect(result.rows[0]?.db).toBe(expectedDatabaseName);
    } finally {
      await client.end();
    }
  });
});
