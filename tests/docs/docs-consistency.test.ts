// Guardia de consistencia de la documentación normativa.
//
// Por qué existe: cada doc del repo afirma cosas sobre el código (paths, archivos, exports, rutas,
// códigos de error). Sin verificación mecánica, esas afirmaciones envejecen en silencio y el agente
// siguiente vuelve a leer src/ para confirmar — el costo exacto que la documentación debía evitar.
//
// D1: todo path en backticks de docs/**/*.md + README.md existe en disco.
// D2: el conjunto de archivos de src/ == el conjunto listado en docs/CODEMAP.md.
// D3: los exports de cada archivo == los nombrados en su fila del CODEMAP (en ambas direcciones).
// D4: docs/api.md documenta las rutas del registro y los códigos de API_ERROR_CODES (drift → rojo).
// D6: todo tipo SQL monetario citado en la doc normativa declara su ALCANCE (snapshot legacy vs
//     head versionado) y coincide con su fuente de verdad (db/schema.sql / prisma/schema.prisma).
//
// D5 (códigos por operación) vive en tests/docs/openapi.test.ts, contra el contrato.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { API_ERROR_CODES } from "../../src/contracts/index.js";
import { OPERATIONS } from "../../scripts/openapi/registry.js";

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

/** Documentación normativa verificada: AGENTS.md + README.md + docs/**. (`docs/references/**` queda fuera.) */
const NORMATIVE_DOCS = (): readonly string[] => [
  "AGENTS.md",
  // README.md es normativo: es el quickstart (migrate deploy = head versionado) y la tabla de
  // códigos de error. Quedaba fuera y por eso su contrato podía contradecir a docs/database.md.
  "README.md",
  // specs/** queda fuera a propósito: son borradores de plan y citan rutas objetivo que todavía no
  // existen (medido: 13 de 115 citas no resuelven, p. ej. `src/shared/money.ts`, `docs/testing.md`).
  // Un doc es normativo sólo si describe el código tal como está; sumarlos obligaría a relajar la
  // aserción hasta que no verifique nada.
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

// ---------------------------------------------------------------------------
// D6 — tipos SQL citados en la doc: alcance declarado + coincidencia con la fuente
//
// El defecto que motivó D6: docs/database.md afirmaba `numeric(10,2)` como tipo del "esquema
// migrado vigente" mientras prisma/schema.prisma (head versionado) ya declaraba Decimal(24,2).
// Un doc es normativo sólo si sus tipos se pueden contrastar contra algo: acá el alcance sale del
// encabezado de la tabla (snapshot legacy ↔ db/schema.sql, head versionado ↔ prisma/schema.prisma)
// y el tipo de cada columna se compara con esa fuente. Un tipo en una tabla sin alcance es rojo:
// la ambigüedad "10,2 o 24,2" no puede volver a pasar el gate.
// ---------------------------------------------------------------------------

type TypeScope = "legacy" | "head";

/** Columnas financieras que los docs tipan con SQL (el resto del esquema no cambió). */
const MONETARY_COLUMNS: readonly string[] = [
  "orders.size",
  "orders.price",
  "orders.filledPrice",
  "marketdata.high",
  "marketdata.low",
  "marketdata.open",
  "marketdata.close",
  "marketdata.previousclose",
];

const KNOWN_COLUMNS = new Set(MONETARY_COLUMNS.map((column) => column.toLowerCase()));

const normalizeType = (raw: string): string =>
  raw.toLowerCase().replace(/\s+/g, "").replace(/"/g, "");

/** Tipos del snapshot legacy, de `db/schema.sql`: `orders.price` → `numeric(10,2)`. */
const legacySqlTypes = (): ReadonlyMap<string, string> => {
  const types = new Map<string, string>();
  let table: string | null = null;
  for (const line of read("db/schema.sql").split("\n")) {
    const tableMatch = /^CREATE TABLE IF NOT EXISTS public\."?(\w+)"?\s*\(/.exec(line);
    if (tableMatch !== null) {
      table = (tableMatch[1] as string).toLowerCase();
      continue;
    }
    if (/^\);/.test(line)) {
      table = null;
      continue;
    }
    const columnMatch = /^\s{4}"(\w+)"\s+([A-Za-z]+(?:\(\d+(?:,\s*\d+)?\))?)/.exec(line);
    if (table === null || columnMatch === null) continue;
    types.set(`${table}.${(columnMatch[1] as string).toLowerCase()}`, normalizeType(columnMatch[2] as string));
  }
  return types;
};

/** Tipos del head versionado, de `prisma/schema.prisma`: `orders.price` → `numeric(24,2)`. */
const headSqlTypes = (): ReadonlyMap<string, string> => {
  const types = new Map<string, string>();
  for (const block of read("prisma/schema.prisma").matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = block[2] as string;
    const mapped = /@@map\("(\w+)"\)/.exec(body);
    const table = (mapped === null ? (block[1] as string) : (mapped[1] as string)).toLowerCase();
    for (const line of body.split("\n")) {
      const field = /^\s{2}(\w+)\s+(\S+)(.*)$/.exec(line);
      if (field === null) continue;
      const name = field[1] as string;
      const prismaType = field[2] as string;
      const rest = field[3] as string;
      const column = (/@map\("(\w+)"\)/.exec(rest)?.[1] ?? name).toLowerCase();
      const decimal = /@db\.Decimal\((\d+),\s*(\d+)\)/.exec(rest);
      const type = decimal === null
        ? prismaType === "Int" ? "integer" : null
        : `numeric(${decimal[1]},${decimal[2]})`;
      if (type !== null) types.set(`${table}.${column}`, normalizeType(type));
    }
  }
  return types;
};

const splitCells = (line: string): readonly string[] =>
  line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());

const scopeOfHeader = (cell: string): TypeScope | null => {
  if (/legacy|snapshot/i.test(cell)) return "legacy";
  if (/head versionado|migrad/i.test(cell)) return "head";
  return null;
};

/** Columnas monetarias nombradas en la primera celda (calificadas o relativas a la sección). */
const namedColumns = (cell: string, sectionTable: string | null): readonly string[] => {
  const refs: string[] = [];
  for (const token of backticked(cell)) {
    const qualified = /^(\w+)\.(\w+)$/.exec(token);
    if (qualified !== null) refs.push(`${qualified[1]}.${qualified[2]}`.toLowerCase());
    else if (sectionTable !== null) refs.push(`${sectionTable}.${token}`.toLowerCase());
  }
  return refs.filter((ref) => KNOWN_COLUMNS.has(ref));
};

const SQL_TYPE_CELL = /(numeric\(\d+\s*,\s*\d+\)|\binteger\b)/i;

interface SqlTypes {
  readonly legacy: ReadonlyMap<string, string>;
  readonly head: ReadonlyMap<string, string>;
}

const verifyMonetaryCell = (
  doc: string,
  lineNumber: number,
  cell: string,
  scope: TypeScope | null,
  columns: readonly string[],
  types: SqlTypes,
): { readonly problems: readonly string[]; readonly verified: readonly string[] } => {
  const problems: string[] = [];
  const verified: string[] = [];
  if (scope === null) {
    problems.push(
      `${doc}:${lineNumber}: tipo SQL en tabla sin alcance declarado (snapshot legacy / head versionado) — ${columns.join(", ")}`,
    );
    return { problems, verified };
  }
  for (const column of columns) {
    const expected = (scope === "legacy" ? types.legacy : types.head).get(column);
    if (expected === undefined) continue;
    if (normalizeType(cell).includes(expected)) verified.push(`${scope}:${column}`);
    else problems.push(`${doc}:${lineNumber}: ${column} como ${scope} vale "${expected}" y la celda dice "${cell}"`);
  }
  return { problems, verified };
};

const scanSqlTypeRow = (
  doc: string,
  lineNumber: number,
  cells: readonly string[],
  scopes: readonly (TypeScope | null)[],
  sectionTable: string | null,
  types: SqlTypes,
): { readonly problems: readonly string[]; readonly verified: readonly string[] } => {
  const problems: string[] = [];
  const verified: string[] = [];
  const columns = namedColumns(cells[0] ?? "", sectionTable);
  if (columns.length === 0) return { problems, verified };
  for (let index = 1; index < cells.length; index += 1) {
    const cell = cells[index] as string;
    if (!SQL_TYPE_CELL.test(cell)) continue;
    const found = verifyMonetaryCell(doc, lineNumber, cell, scopes[index] ?? null, columns, types);
    problems.push(...found.problems);
    verified.push(...found.verified);
  }
  return { problems, verified };
};

const scanSqlTypeTables = (
  doc: string,
  content: string,
  types: SqlTypes,
): { readonly problems: readonly string[]; readonly verified: readonly string[] } => {
  const problems: string[] = [];
  const verified: string[] = [];
  const lines = content.split("\n");
  let sectionTable: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const heading = /^#{1,4} `(\w+)`\s*$/.exec(line);
    if (heading !== null) sectionTable = (heading[1] as string).toLowerCase();
    const isTableHeader = line.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[index + 1] ?? "");
    if (!isTableHeader) {
      index += 1;
      continue;
    }
    const headerCells = splitCells(line);
    const scopes = headerCells.map((cell) => scopeOfHeader(cell));
    let row = index + 2;
    while (row < lines.length && (lines[row] as string).startsWith("|")) {
      const found = scanSqlTypeRow(doc, row + 1, splitCells(lines[row] as string), scopes, sectionTable, types);
      problems.push(...found.problems);
      verified.push(...found.verified);
      row += 1;
    }
    index = row;
  }
  return { problems, verified };
};

describe("documentación ↔ código", () => {
  it("D1 — todo path citado en la documentación normativa existe", () => {
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

  it("D4 — docs/api.md documenta las rutas del registro y los códigos del contrato", () => {
    // api.md explica semántica SIN repetir el contrato (openapi.json es la fuente de
    // forma). Igual debe nombrar cada ruta y cada código: si algo se muda o renombra,
    // este assert rota en vez de quedar stale en silencio.
    const apiDoc = read("docs/api.md");
    for (const operation of OPERATIONS) {
      expect(apiDoc).toContain(
        `${operation.method.toUpperCase()} ${operation.expressPath}`,
      );
    }
    for (const code of Object.values(API_ERROR_CODES)) {
      expect(apiDoc).toContain(code);
    }
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

  it("D6 — los tipos SQL de la doc declaran su alcance y coinciden con su fuente", () => {
    const types: SqlTypes = { legacy: legacySqlTypes(), head: headSqlTypes() };
    // Anti-vacío: si el parser de las fuentes se rompe, el test falla acá y no pasa "por vacío".
    expect(types.legacy.get("orders.price")).toBe("numeric(10,2)");
    expect(types.head.get("orders.price")).toBe("numeric(24,2)");
    expect(types.head.get("orders.size")).toBe("numeric(24,2)");
    expect(types.head.get("marketdata.previousclose")).toBe("numeric(24,2)");

    const problems: string[] = [];
    const verifiedInDatabase = new Set<string>();
    for (const doc of NORMATIVE_DOCS()) {
      const found = scanSqlTypeTables(doc, read(doc), types);
      problems.push(...found.problems);
      if (doc === "docs/database.md") for (const key of found.verified) verifiedInDatabase.add(key);
    }
    expect(problems).toEqual([]);

    // Cada columna monetaria debe estar tipada como head en database.md: una tabla borrada o
    // "neutralizada" no puede hacer pasar el test por falta de afirmaciones.
    const missingHeadClaims = MONETARY_COLUMNS.filter(
      (column) => types.head.has(column) && !verifiedInDatabase.has(`head:${column}`),
    );
    expect(missingHeadClaims).toEqual([]);
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
