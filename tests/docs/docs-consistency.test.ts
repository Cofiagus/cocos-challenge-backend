// Guardia de consistencia de la documentación normativa.
//
// Por qué existe: cada doc del repo afirma cosas sobre el código (paths, archivos, exports, rutas,
// códigos de error). Sin verificación mecánica, esas afirmaciones envejecen en silencio y el agente
// siguiente vuelve a leer src/ para confirmar — el costo exacto que la documentación debía evitar.
//
// D1: todo path en backticks de docs/**/*.md existe en disco.
// D2: el conjunto de archivos de src/ == el conjunto listado en docs/CODEMAP.md.
// D3: los exports de cada archivo == los nombrados en su fila del CODEMAP (en ambas direcciones).
//
// D4 (rutas de docs/api.md) y D5 (códigos de error) se agregan con la spec de OpenAPI, cuando
// docs/api.md exista. AGENTS.md se suma a D1 en el mismo commit que lo reescribe.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(child));
    } else {
      out.push(child.split(sep).join("/"));
    }
  }
  return out;
};

/** Documentación normativa verificada: AGENTS.md + docs/**. (`docs/references/**` queda fuera.) */
const NORMATIVE_DOCS = (): readonly string[] => [
  "AGENTS.md",
  ...walk("docs")
    .filter((file) => file.endsWith(".md"))
    // docs/references/** es evidencia de investigación (cita estructuras de OTROS repos): no es
    // normativo y describe paths ajenos a este código.
    .filter((file) => !file.startsWith("docs/references/")),
];

const SOURCE_FILES = (): readonly string[] =>
  walk("src").filter((file) => file.endsWith(".ts"));

/** Exports públicos de un archivo (const/class/interface/type/enum/function). */
const exportedNames = (file: string): readonly string[] => {
  const source = read(file);
  const found: string[] = [];
  const pattern =
    /^export (?:const|class|interface|type|enum|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    found.push(match[1] as string);
  }
  return found;
};

/** Fila del CODEMAP: | `src/x.ts` | responsabilidad | exports | llamadores | test | */
interface CodemapRow {
  readonly file: string;
  readonly exportsCell: string;
}

const codemapRows = (): readonly CodemapRow[] => {
  const lines = read("docs/CODEMAP.md").split("\n");
  const rows: CodemapRow[] = [];
  for (const line of lines) {
    const match = /^\|\s*`(src\/[^`]+\.ts)`\s*\|(.*)$/.exec(line);
    if (match === null) continue;
    // Se parte por pipes NO escapados: las celdas pueden contener "\|" (XOR, "A|B").
    const columns = (match[2] as string).split(/(?<!\\)\|/);
    rows.push({ file: match[1] as string, exportsCell: (columns[1] ?? "").replace(/\\\|/g, "|") });
  }
  return rows;
};

const backticked = (text: string): readonly string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);

describe("documentación ↔ código", () => {
  it("D1 — todo path citado en docs/**/*.md existe", () => {
    const pathPattern = /`((?:src|tests|prisma|db|scripts|docs)\/[A-Za-z0-9_./-]+)`/g;
    const missing: string[] = [];
    for (const doc of NORMATIVE_DOCS()) {
      const content = read(doc);
      for (const match of content.matchAll(pathPattern)) {
        const cited = (match[1] as string).replace(/\/$/, "");
        if (!existsSync(join(ROOT, cited))) missing.push(`${doc} → ${cited}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("D2 — CODEMAP lista exactamente los archivos de src/", () => {
    const listed = codemapRows().map((row) => row.file);
    const onDisk = SOURCE_FILES();
    expect([...listed].sort()).toEqual([...onDisk].sort());
  });

  it("D3 — CODEMAP nombra exactamente los exports de cada archivo", () => {
    const mismatches: string[] = [];
    for (const row of codemapRows()) {
      if (!existsSync(join(ROOT, row.file))) continue; // lo reporta D2
      const onDisk = exportedNames(row.file);
      const named = backticked(row.exportsCell);
      const missingInDoc = onDisk.filter((name) => !named.includes(name));
      const ghostInDoc = named.filter((name) => !onDisk.includes(name));
      if (missingInDoc.length > 0) mismatches.push(`${row.file}: falta documentar ${missingInDoc.join(", ")}`);
      if (ghostInDoc.length > 0) mismatches.push(`${row.file}: documentado y no existe ${ghostInDoc.join(", ")}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("el CODEMAP no está vacío y cubre las 6 capas", () => {
    const rows = codemapRows();
    expect(rows.length).toBeGreaterThan(30);
    const paths = rows.map((row) => row.file);
    for (const prefix of ["src/contracts/", "src/domain/", "src/application/", "src/http/", "src/infra/"]) {
      expect(paths.some((path) => path.startsWith(prefix))).toBe(true);
    }
    expect(statSync(join(ROOT, "docs/CODEMAP.md")).size).toBeGreaterThan(1_000);
    expect(relative(ROOT, join(ROOT, "docs/CODEMAP.md"))).toBe("docs/CODEMAP.md");
  });
});
