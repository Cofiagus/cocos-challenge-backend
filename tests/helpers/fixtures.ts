// Fixtures del seed (db/seed.sql): IDs, precios de referencia y golden
// values del portfolio del user 1 — verificados corriendo
// db/queries/portfolio.sql sobre el schema migrado + seed.
//
// Los tests NO hardcodean estos valores sueltos: importan de acá.

export const SEED_USER_EMILIANO_ID = 1;

export const SEED_INSTRUMENT_PAMP_ID = 47;
export const SEED_INSTRUMENT_METR_ID = 54;
export const SEED_INSTRUMENT_BMA_ID = 31;
export const SEED_INSTRUMENT_LOMA_ID = 45;
/** ARS, type MONEDA — no operable, excluida de búsqueda y positions. */
export const SEED_INSTRUMENT_ARS_ID = 66;

/** Instrumentos SIN marketdata en el seed → precio de referencia null (NO_PRICE). */
export const SEED_INSTRUMENTS_WITHOUT_MARKETDATA = [3, 10, 66] as const;

/** Última fecha de marketdata del seed. */
export const SEED_LATEST_MARKETDATA_DATE = "2023-07-14";

/** Closes de referencia del seed (SEED_LATEST_MARKETDATA_DATE) — strings, nunca float. */
export const SEED_REFERENCE_CLOSES = {
  PAMP: "925.85",
  METR: "229.50",
  BMA: "1502.80",
} as const;

/**
 * Golden values del portfolio del user 1 (docs/database.md §3, verificados
 * sobre schema migrado + seed): cash disponible, reservas y posiciones.
 */
export const SEED_USER_1_PORTFOLIO = {
  cashSettledArs: "753000.00",
  cashReservedArs: "125500.00",
  /** cashSettled − cashReserved. */
  cashAvailableArs: "627500.00",
  positions: [
    { ticker: "BMA", quantityShares: -10, weightedAverageCostArs: "1540.00" },
    { ticker: "METR", quantityShares: 500, weightedAverageCostArs: "250.00" },
    { ticker: "PAMP", quantityShares: 40, weightedAverageCostArs: "930.00" },
  ],
} as const;