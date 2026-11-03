/**
 * Jest corre los .ts de tests/ transformados a CommonJS vía ts-jest
 * (tsconfig.test.json), aunque la app misma es ESM (package.json type=module).
 * El typecheck real lo hace `npm run typecheck` (tsc --noEmit con module=nodenext).
 *
 * PROYECTOS separados por DB (jest.config, orquestador): cada suite funcional
 * corre contra SU postgres (aislamiento real, sin interferencia entre suites
 * en workers paralelos). El proyecto "uc3-functional" existe porque la suite
 * de la Célula D (tests/functional/orders/**) NO setea DATABASE_URL (su pool
 * es propio) y GATE 3 la corre SIN modificarla: el setup del proyecto la
 * apunta a cocos_challenge_ftest, la misma DB que aserta su pool.
 *
 * Tests que necesiten la DB: `npm run test:db:reset` antes (recrea
 * cocos_challenge_test desde la migración versionada + seed, sin docker);
 * las suites funcionales se auto-resetean en beforeAll vía TEST_DB_NAME.
 */

/** Base común (transform + mapper .js→.ts para nodenext). */
const base = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleNameMapper: {
    // jest-resolve NO mapea .js→.ts: los imports con extensión .js (exigidos
    // por module=nodenext) deben resolverse a los .ts fuente en los tests.
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
      setupFiles: ["<rootDir>/tests/setup/database-url-ftest.ts"],
    },
  ],
};