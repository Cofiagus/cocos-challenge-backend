/**
 * Jest corre los .ts de tests/ transformados a CommonJS vía ts-jest
 * (tsconfig.test.json), aunque la app misma es ESM (package.json type=module).
 * El typecheck real lo hace `npm run typecheck` (tsc --noEmit con module=nodenext).
 *
 * PROYECTOS separados por DB: cada suite funcional corre contra SU postgres
 * (aislamiento real, sin interferencia entre suites en workers paralelos).
 * El proyecto "uc3-functional" usa el URL derivado de TEST_DATABASE_URL
 * para su propia base.
 *
 * Tests que necesitan DB: `TEST_DATABASE_URL` debe estar configurada en
 * `.env.test`; `npm run test:db:reset` recrea las bases aisladas del test.
 */

/** Base común (transform + mapper .js→.ts para nodenext). */
const base = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setup/test-database-env.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  // tsc (nodenext) exige extensión .js en los imports relativos; jest-resolve
  // NO mapea .js → .ts por sí solo, así que se la damos acá.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};

/** @type {import('jest').Config} */
export default {
  projects: [
    {
      ...base,
      displayName: "app",
      testMatch: ["<rootDir>/tests/**/*.test.ts"],
      testPathIgnorePatterns: ["<rootDir>/tests/functional/orders/"],
    },
    {
      ...base,
      displayName: "uc3-functional",
      testMatch: ["<rootDir>/tests/functional/orders/**/*.test.ts"],
      setupFiles: [
        "<rootDir>/tests/setup/test-database-env.ts",
        "<rootDir>/tests/setup/database-url-ftest.ts",
      ],
    },
  ],
};