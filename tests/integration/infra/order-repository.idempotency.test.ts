// Integración (DB real: cocos_challenge_test) — idempotencia de
// PrismaOrderRepository.createOrder: ON CONFLICT DO NOTHING sobre
// UNIQUE(userid, idempotencyKey) como PRIMERA escritura del envío
// (DECISIONS.md).
//
// Prerequisito: `npm run test:db:reset` antes de la suite.

import { config } from "dotenv";

config({ path: ".env.test" });

import { Decimal } from "decimal.js";
import type { OrderDraft } from "../../../src/contracts/index.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { createTestUser } from "../../helpers/factories.js";
import {
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
} from "../../helpers/fixtures.js";
import {
  buildDraft,
  expectConflict,
  expectCreated,
  expectReplay,
} from "./support.js";

describe("PrismaOrderRepository — idempotencia (DB real)", () => {
  const prisma = getPrismaClient();
  const orderRepo = new PrismaOrderRepository();

  afterAll(async () => {
    // Cierre ordenado del pool del adapter para que el worker de jest termine limpio.
    await prisma.$disconnect();
  });

  /** Envío completo: la transacción con lock por usuario del repositorio. */
  const submit = (draft: OrderDraft) =>
    orderRepo.withUserTransaction(draft.userId, (tx) =>
      orderRepo.createOrder(draft, tx),
    );

  it("misma key dos veces ⇒ CREATED + IDEMPOTENT_REPLAY con la MISMA orden y UNA sola fila", async () => {
    const user = await createTestUser(prisma);
    const draft = buildDraft(user.id);

    const created = expectCreated(await submit(draft));
    expect(created.status).toBe("NEW");
    expect(created.side).toBe("BUY");
    expect(created.priceArs?.toFixed(2)).toBe("930.00");

    // Reenvío idéntico (misma key, mismo payload).
    const replayed = expectReplay(await submit(draft));
    expect(replayed.id).toBe(created.id);
    expect(replayed.datetime.toISOString()).toBe(created.datetime.toISOString());
    expect(replayed.priceArs?.toFixed(2)).toBe("930.00");

    // UNA fila, no dos: el ON CONFLICT DO NOTHING no insertó.
    const rows = await prisma.order.count({
      where: { userId: user.id, idempotencyKey: draft.idempotencyKey },
    });
    expect(rows).toBe(1);
  });

  it("misma key + payload distinto ⇒ IDEMPOTENT_CONFLICT (409 en la app), fila original SIN mutar", async () => {
    const user = await createTestUser(prisma);
    const draft = buildDraft(user.id);
    const created = expectCreated(await submit(draft));

    // Variantes que cambian el payload comparado (una por campo), todas
    // con la MISMA key del envío original.
    const conflictingDrafts: readonly Partial<OrderDraft>[] = [
      { instrumentId: SEED_INSTRUMENT_METR_ID },
      { side: "SELL" },
      { type: "MARKET" },
      { timeInForce: "IOC" },
      { sizeShares: 25 },
      { priceArs: new Decimal("999.00") },
    ];
    for (const overrides of conflictingDrafts) {
      const conflict = expectConflict(
        await submit(
          buildDraft(user.id, {
            idempotencyKey: draft.idempotencyKey,
            ...overrides,
          }),
        ),
      );
      // La orden devuelta es la ORIGINAL, campo por campo contra el envío.
      expect(conflict.id).toBe(created.id);
      expect(conflict.sizeShares).toBe(10);
      expect(conflict.priceArs?.toFixed(2)).toBe("930.00");
      expect(conflict.instrumentId).toBe(SEED_INSTRUMENT_PAMP_ID);
    }

    // Sin mutación: sigue habiendo UNA fila con el payload original.
    const rows = await prisma.order.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(draft.idempotencyKey);
    expect(rows[0]?.size).toBe(10);
    // Prisma.Decimal.toString() normaliza ceros finales ("930.00" → "930"):
    // comparar con toFixed(2), que es la repr del contrato.
    expect(new Decimal(rows[0]?.price?.toString() ?? "0").toFixed(2)).toBe("930.00");
  });

  it("key null ⇒ INSERT directo: dos envíos son dos filas CREATED distintas", async () => {
    const user = await createTestUser(prisma);
    const first = expectCreated(
      await submit(buildDraft(user.id, { idempotencyKey: null })),
    );
    const second = expectCreated(
      await submit(buildDraft(user.id, { idempotencyKey: null })),
    );
    expect(second.id).not.toBe(first.id);
    const rows = await prisma.order.count({ where: { userId: user.id } });
    expect(rows).toBe(2);
  });
});