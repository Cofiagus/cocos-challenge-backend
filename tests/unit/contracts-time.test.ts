// D-01 (F1-TIME): `orders.datetime`/`filledAt` son `timestamp without time
// zone` y @prisma/adapter-pg los interpreta como UTC. `serializeLocalTimestamp`
// re-serializa con los getters LOCALES, así que el texto servido sólo coincide
// con el seed cuando el proceso corre con TZ=UTC (lo fija src/index.ts antes de
// cargar cualquier módulo). El desplazamiento medido: ART servía 12:14:20
// donde db/seed.sql dice 15:14:20 (orden id 5).
//
// Por qué procesos hijos: dentro de Jest, `process.env.TZ` es una copia del
// entorno y mutarlo no cambia la zona que usa Date; para ejercitar zonas
// distintas de verdad cada caso arranca un Node con `TZ=<zona>`.

import { execFileSync } from "node:child_process";

/** Wall clock de la orden id 5 en db/seed.sql: `2023-07-12 15:14:20`. */
const ORDER_5_WALL_CLOCK = "2023-07-12T15:14:20";

const ZONES = [
  "UTC",
  "America/Argentina/Buenos_Aires",
  "Asia/Tokyo",
] as const;

type Zone = (typeof ZONES)[number];

interface SerializationUnderZone {
  /** Date tal como lo entrega el adapter: wall clock del seed interpretado como UTC. */
  readonly adapterUtc: string;
  /** Date con componentes LOCALes iguales al wall clock del mercado. */
  readonly localWallClock: string;
}

const cache = new Map<Zone, SerializationUnderZone>();

/** Serializa los dos Date de referencia en un Node nuevo con TZ=<zone>. */
const serializeUnderZone = (zone: Zone): SerializationUnderZone => {
  const cached = cache.get(zone);
  if (cached !== undefined) return cached;

  const source = `
    import { serializeLocalTimestamp } from "./src/contracts/datetime.ts";
    const adapterUtc = serializeLocalTimestamp(new Date("${ORDER_5_WALL_CLOCK}Z"));
    const localWallClock = serializeLocalTimestamp(new Date(2023, 6, 12, 15, 14, 20));
    console.log(JSON.stringify({ adapterUtc, localWallClock }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, TZ: zone },
    },
  ).trim();

  const result = JSON.parse(stdout) as SerializationUnderZone;
  cache.set(zone, result);
  return result;
};

describe.each(ZONES)("serializeLocalTimestamp con TZ=%s", (zone) => {
  it("serializa los mismos componentes locales al mismo texto", () => {
    expect(serializeUnderZone(zone).localWallClock).toBe(ORDER_5_WALL_CLOCK);
  });

  it("no agrega offset ni sufijo Z (ISO 8601 sin zona)", () => {
    expect(serializeUnderZone(zone).localWallClock).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u,
    );
  });
});

describe("D-01 — invariancia de la zona del proceso", () => {
  it("el mismo wall clock local produce el mismo texto en las tres zonas", () => {
    const serialized = ZONES.map(
      (zone) => serializeUnderZone(zone).localWallClock,
    );
    expect(new Set(serialized).size).toBe(1);
    expect(serialized[0]).toBe(ORDER_5_WALL_CLOCK);
  });

  it("con TZ=UTC (política de src/index.ts) la orden 5 se sirve 15:14:20", () => {
    expect(serializeUnderZone("UTC").adapterUtc).toBe(ORDER_5_WALL_CLOCK);
  });

  it("sin el pin, ART correría el mismo instante 3 h: el defecto que el pin evita", () => {
    expect(serializeUnderZone("America/Argentina/Buenos_Aires").adapterUtc).toBe(
      "2023-07-12T12:14:20",
    );
  });

  it("sin el pin, Tokio correría el mismo instante 9 h", () => {
    expect(serializeUnderZone("Asia/Tokyo").adapterUtc).toBe(
      "2023-07-13T00:14:20",
    );
  });
});
