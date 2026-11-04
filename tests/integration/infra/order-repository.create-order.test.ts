// Integración (DB real: cocos_challenge_test) + tx simulada — caracterización
// de PrismaOrderRepository.createOrder ANTES del refactor: ramas sin
// cobertura (count del claim fuera de {0,1}, fila ausente tras el claim) y
// comparación de precio con UN solo lado NULL.
//
// Prerequisito: `npm run test:db:reset` antes de la suite.

import { config } from "dotenv";

config({ path: ".env.test" });

import { Decimal } from "decimal.js";
import type {
  OrderDraft,
  TransactionContext,
} from "../../../src/contracts/index.js";
import { CorruptRowError } from "../../../src/infra/prisma/corrupt-row.error.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { createTestUser } from "../../helpers/factories.js";
import {
  buildDraft,
  expectConflict,
  expectCreated,
  expectReplay,
} from "./support.js";

/**
 * Cliente de transacción SIMULADO para las ramas que el SQL real no puede
 * producir (ON CONFLICT nunca devuelve un count fuera de {0,1} ni deja la
 * fila del claim ausente): solo los mensajes que createOrder usa en el
 * camino con idempotencyKey.
 */
interface ClaimOnlyDb {
  readonly $executeRaw: () => Promise<number>;
  readonly order: {
    readonly findFirst: () => Promise<null>;
  };
}

const asTransactionContext = (db: ClaimOnlyDb): TransactionContext =>
  db as unknown as TransactionContext;

describe("PrismaOrderRepository.createOrder — caracterización (DB real)", () => {
  const prisma = getPrismaClient();
  const orderRepo = new PrismaOrderRepository();

  afterAll(async () => {
    // Cierre ordenado del pool del adapter para que el worker de jest termine limpio.
    await prisma.$disconnect();
  });

  const submit = (draft: OrderDraft) =>
    orderRepo.withUserTransaction(draft.userId, (tx) =>
      orderRepo.createOrder(draft, tx),
    );

  it("price NULL en la fila y no-NULL en el draft ⇒ IDEMPOTENT_CONFLICT", async () => {
    const user = await createTestUser(prisma);
    const draft = buildDraft(user.id, { priceArs: null });
    const created = expectCreated(await submit(draft));
    expect(created.priceArs).toBeNull();

    // Misma key y mismo resto del payload, ahora con precio de límite.
    const conflicted = expectConflict(
      await submit(
        buildDraft(user.id, {
          idempotencyKey: draft.idempotencyKey,
          priceArs: new Decimal("930.00"),
        }),
      ),
    );
    expect(conflicted.id).toBe(created.id);
    expect(conflicted.priceArs).toBeNull();
  });

  it("price no-NULL en la fila y NULL en el draft ⇒ IDEMPOTENT_CONFLICT", async () => {
    const user = await createTestUser(prisma);
    const draft = buildDraft(user.id);
    const created = expectCreated(await submit(draft));

    const conflicted = expectConflict(
      await submit(
        buildDraft(user.id, {
          idempotencyKey: draft.idempotencyKey,
          priceArs: null,
        }),
      ),
    );
    expect(conflicted.id).toBe(created.id);
    expect(conflicted.priceArs?.toFixed(2)).toBe("930.00");
  });

  it("price NULL en ambos lados ⇒ IDEMPOTENT_REPLAY", async () => {
    const user = await createTestUser(prisma);
    const draft = buildDraft(user.id, { priceArs: null });
    const created = expectCreated(await submit(draft));
    const replayed = expectReplay(await submit(draft));
    expect(replayed.id).toBe(created.id);
    expect(replayed.priceArs).toBeNull();
  });
});

describe("PrismaOrderRepository.createOrder — ramas de corrupción (tx simulada)", () => {
  const orderRepo = new PrismaOrderRepository();

  it.each([2, -1])(
    "count del claim = %i (fuera de {0,1}) ⇒ CorruptRowError",
    async (unexpectedCount) => {
      const db: ClaimOnlyDb = {
        $executeRaw: () => Promise.resolve(unexpectedCount),
        order: {
          findFirst: () => {
            throw new Error("no debe leer la fila con un count inesperado");
          },
        },
      };
      await expect(
        orderRepo.createOrder(buildDraft(1), asTransactionContext(db)),
      ).rejects.toThrow(CorruptRowError);
    },
  );

  it.each([0, 1])(
    "count = %i y fila del claim ausente ⇒ CorruptRowError",
    async (inserted) => {
      const db: ClaimOnlyDb = {
        $executeRaw: () => Promise.resolve(inserted),
        order: { findFirst: () => Promise.resolve(null) },
      };
      await expect(
        orderRepo.createOrder(buildDraft(1), asTransactionContext(db)),
      ).rejects.toThrow(/fila del claim idempotente/);
    },
  );
});
