/**
 * Jest corre los .ts de tests/ transformados a CommonJS vía ts-jest
 * (tsconfig.test.json), aunque la app misma es ESM (package.json type=module).
 * El typecheck real lo hace `npm run typecheck` (tsc --noEmit con module=nodenext).
 *
 * Tests que necesiten la DB: `npm run test:db:reset` antes (reset de
 * cocos_challenge_test desde el template, sin docker).
 */

/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
};
