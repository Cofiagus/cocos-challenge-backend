// Soporte compartido de los tests de integración de infra (célula B).
// SOLO para tests: builder de drafts + helpers de narrowing del
// CreateOrderResult (jest no estrecha tras expect(...).toBe(...)).
//
// Requisito de la suite: `npm run test:db:reset` antes de `npm test`
// (recrea cocos_challenge_test desde migración versionada + seed).

import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type {
  CreateOrderResult,
  OrderDraft,
  OrderRecord,
} from "../../../src/contracts/index.js";
import { SEED_INSTRUMENT_PAMP_ID } from "../../helpers/fixtures.js";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Draft default: LIMIT BUY NEW GTC, 10 acciones @ 930.00 (precio del seed
 * de PAMP), key aleatoria — el payload "vanilla" del envío. Dinero como
 * Decimal construido desde string (AGENTS.md).
 */
export const buildDraft = (
  userId: number,
  overrides: Partial<OrderDraft> = {},
): OrderDraft => ({
  userId,
  instrumentId: SEED_INSTRUMENT_PAMP_ID,
  side: "BUY",
  type: "LIMIT",
  timeInForce: "GTC",
  status: "NEW",
  sizeShares: 10,
  priceArs: new Decimal("930.00"),
  filledPriceArs: null,
  filledAt: null,
  idempotencyKey: randomUUID(),
  datetime: new Date(),
  ...overrides,
});

export const expectCreated = (result: CreateOrderResult): OrderRecord => {
  if (result.outcome !== "CREATED") {
    throw new Error(`esperaba CREATED, llegó ${result.outcome}`);
  }
  return result.order;
};

export const expectReplay = (result: CreateOrderResult): OrderRecord => {
  if (result.outcome !== "IDEMPOTENT_REPLAY") {
    throw new Error(`esperaba IDEMPOTENT_REPLAY, llegó ${result.outcome}`);
  }
  return result.order;
};

export const expectConflict = (result: CreateOrderResult): OrderRecord => {
  if (result.outcome !== "IDEMPOTENT_CONFLICT") {
    throw new Error(`esperaba IDEMPOTENT_CONFLICT, llegó ${result.outcome}`);
  }
  return result.order;
};