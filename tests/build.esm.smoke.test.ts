// Smoke del ARTEFACTO que se despliega: dist/ importado por Node como ESM real.
//
// Por qué existe: jest transpila los .ts a CommonJS con ts-jest y mapea `.js` → `.ts`
// (jest.config.js, moduleNameMapper), así que un import que sólo rompe bajo
// `module=nodenext` (extensión ausente, subpath mal resuelto, export que no existe
// en runtime) puede pasar inadvertido en toda la suite. acá se compila con
// `npm run build` y se importa el JavaScript emitido desde un proceso Node ESM
// aparte, con la resolución de módulos de verdad (condición "import", extensiones
// obligatorias, `"type": "module"`).
//
// No necesita DB ni abre puerto: sólo importa los barrels hoja (domain y contracts),
// nunca `dist/index.js`, que hace `listen()`.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Módulos compilados que se importan: barrels puros, sin I/O ni listen(). */
const DIST_MODULES = ["./dist/domain/index.js", "./dist/contracts/index.js"] as const;

/** Mínimo de exports por módulo: si el build emite un módulo vacío, esto lo delata. */
const MINIMUM_EXPORTS: Readonly<Record<string, number>> = {
  "./dist/domain/index.js": 8,
  "./dist/contracts/index.js": 40,
};

interface ImportedNamespace {
  readonly specifier: string;
  readonly tag: string;
  readonly exports: readonly string[];
}

interface ResolutionFailure {
  readonly specifier: string;
  readonly code: string;
}

/** stderr/stdout del proceso hijo, para que un rojo diga QUÉ se rompió. */
const failedOutput = (error: unknown): string => {
  const captured = error as { stdout?: unknown; stderr?: unknown };
  const text = [captured.stdout, captured.stderr]
    .map((chunk) => (typeof chunk === "string" ? chunk : ""))
    .join("\n")
    .trim();
  return text === "" ? "" : `\n${text}`;
};

/** Compila src/ → dist/ con el mismo comando que el deploy. */
const runBuild = (): void => {
  try {
    execFileSync("npm", ["run", "build"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
  } catch (error) {
    throw new Error(`npm run build falló:${failedOutput(error)}`);
  }
};

/** Corre un fragmento ESM en un proceso Node nuevo y devuelve su stdout. */
const runEsmProbe = (source: string): string => {
  try {
    return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }).trim();
  } catch (error) {
    throw new Error(`el probe ESM de Node falló:${failedOutput(error)}`);
  }
};

const importNamespaces = (): readonly ImportedNamespace[] => {
  const stdout = runEsmProbe(`
    const specifiers = ${JSON.stringify(DIST_MODULES)};
    const report = [];
    for (const specifier of specifiers) {
      const namespace = await import(new URL(specifier, \`file://\${process.cwd()}/\`).href);
      report.push({
        specifier,
        tag: Object.prototype.toString.call(namespace),
        exports: Object.keys(namespace).sort(),
      });
    }
    console.log(JSON.stringify(report));
  `);
  return JSON.parse(stdout) as ImportedNamespace[];
};

describe("smoke: artefacto ESM compilado (dist/)", () => {
  beforeAll(() => {
    runBuild();
  }, 180_000);

  it("el build emite los barrels que el smoke importa", () => {
    for (const specifier of DIST_MODULES) {
      expect(existsSync(join(ROOT, specifier))).toBe(true);
    }
  });

  it("Node resuelve e importa dist/ como ESM (namespace real, no exports de CJS)", () => {
    const namespaces = importNamespaces();
    expect(namespaces).toHaveLength(DIST_MODULES.length);

    for (const [index, specifier] of DIST_MODULES.entries()) {
      const imported = namespaces[index];
      expect(imported).toBeDefined();
      expect(imported?.specifier).toBe(specifier);
      // Un namespace ESM se ve así; require(esm) desde CJS no produce este tag.
      expect(imported?.tag).toBe("[object Module]");
      expect(imported?.exports.length).toBeGreaterThanOrEqual(
        MINIMUM_EXPORTS[specifier] ?? 1,
      );
    }
  });

  it("los exports públicos siguen presentes en el artefacto compilado", () => {
    const namespaces = importNamespaces();
    const exported = (specifier: string): readonly string[] =>
      namespaces.find((namespace) => namespace.specifier === specifier)?.exports ?? [];

    expect(exported("./dist/domain/index.js")).toEqual(
      expect.arrayContaining([
        "deriveCash",
        "derivePositions",
        "matchRestingOrders",
        "sizeSharesFromAmountArs",
      ]),
    );
    expect(exported("./dist/contracts/index.js")).toEqual(
      expect.arrayContaining([
        "API_ERROR_CODES",
        "CreateOrderRequestSchema",
        "MoneyArsSchema",
        "OrderResponseSchema",
      ]),
    );
  });

  it("control negativo: la resolución ESM estricta rechaza un import sin extensión", () => {
    // Si este probe resolviera sin extensión, estaría corriendo con la resolución
    // laxa de CJS y el smoke no probaría nada sobre nodenext.
    const stdout = runEsmProbe(`
      const specifier = "./dist/domain/index";
      try {
        await import(new URL(specifier, \`file://\${process.cwd()}/\`).href);
        console.log(JSON.stringify({ specifier, code: "RESOLVED" }));
      } catch (error) {
        console.log(JSON.stringify({ specifier, code: error.code ?? "UNKNOWN" }));
      }
    `);
    const failure = JSON.parse(stdout) as ResolutionFailure;
    expect(failure.specifier).toBe("./dist/domain/index");
    expect(failure.code).toBe("ERR_MODULE_NOT_FOUND");
  });
});
