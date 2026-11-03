/**
 * Jest corre los .ts de tests/ transformados a CommonJS vía ts-jest
 * (tsconfig.test.json), aunque la app misma es ESM (package.json type=module).
 * El typecheck real lo hace `npm run typecheck` (tsc --noEmit con module=nodenext).
 *
 * Tests que necesiten la DB: `npm run test:db:reset` antes (recrea
 * cocos_challenge_test desde la migración versionada + seed, sin docker).
 */

/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleNameMapper: {
    // jest-resolve NO mapea .js→.ts: los imports con extensión .js (exigidos
    // por module=nodenext) deben resolverse a los .ts fuente en los tests.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
