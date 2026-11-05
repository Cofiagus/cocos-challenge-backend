// Integración (DB real: cocos_challenge_test) — idempotencia de
// PrismaOrderRepository.createOrder: ON CONFLICT DO NOTHING sobre
// UNIQUE(userid, idempotencyKey) como PRIMERA escritura del envío
// (DECISIONS.md).
//
// Prerequisito: `npm run test:db:reset` antes de la suite.

import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.test" });

import { Prisma, type PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import type { OrderDraft, OrderEventType } from "../../../src/contracts/index.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { createTestUser } from "../../helpers/factories.js";
import {
  SEED_INSTRUMENT_ARS_ID,
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
} from "../../helpers/fixtures.js";
import {
  buildCashDraft,
  buildDraft,
  expectCashRecord,
  expectConflict,
  expectCreated,
  expectReplay,
  expectTradingRecord,
  type TradingDraftOverrides,
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
    const conflictingDrafts: readonly Partial<TradingDraftOverrides>[] = [
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
      expect(expectTradingRecord(conflict).sizeShares).toBe(10);
      expect(conflict.priceArs?.toFixed(2)).toBe("930.00");
      expect(conflict.instrumentId).toBe(SEED_INSTRUMENT_PAMP_ID);
    }

    // Sin mutación: sigue habiendo UNA fila con el payload original.
    const rows = await prisma.order.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(draft.idempotencyKey);
    expect(rows[0]?.size?.toString()).toBe("10");
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

// ---------------------------------------------------------------------------
// Cash: montos exactos y evidencia histórica (D4, spec §5)
// ---------------------------------------------------------------------------

/** Pedido cash RAW (como lo dejó una versión anterior): size entero + evento. */
interface SeedCashOrderInput {
  readonly size: string;
  readonly idempotencyKey: string;
  readonly price?: string;
  readonly events?: readonly {
    readonly eventType: OrderEventType;
    readonly metadata: unknown;
  }[];
}

const seedCashOrder = async (
  client: PrismaClient,
  userId: number,
  input: SeedCashOrderInput,
): Promise<number> =>
  // Orden + eventos en la MISMA transacción, como los escribe la aplicación.
  client.$transaction(async (tx) => {
    const row = await tx.order.create({
      data: {
        userId,
        instrumentId: SEED_INSTRUMENT_ARS_ID,
        side: "CASH_IN",
        type: "MARKET",
        timeInForce: "GTC",
        status: "FILLED",
        size: input.size,
        price: input.price ?? "1.00",
        filledPrice: input.price ?? "1.00",
        filledAt: new Date(),
        datetime: new Date(),
        idempotencyKey: input.idempotencyKey,
      },
    });
    for (const event of input.events ?? []) {
      await tx.orderEvent.create({
        data: {
          orderId: row.id,
          eventType: event.eventType,
          metadata: event.metadata as Prisma.InputJsonValue,
        },
      });
    }
    return row.id;
  });

describe("PrismaOrderRepository — idempotencia cash exacta (DB real)", () => {
  const prisma = getPrismaClient();
  const orderRepo = new PrismaOrderRepository();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Envío completo como la aplicación: claim + evento en la MISMA tx.
   * Sólo CREATED escribe evento; replay/conflicto no tocan auditoría.
   */
  const submit = (draft: ReturnType<typeof buildCashDraft>) =>
    orderRepo.withUserTransaction(draft.userId, async (tx) => {
      const result = await orderRepo.createOrder(draft, tx);
      if (result.outcome === "CREATED") {
        await orderRepo.appendOrderEvent(
          {
            orderId: result.order.id,
            eventType: "ACCEPTED",
            reason: null,
            metadata: {
              ticker: "ARS",
              amountArs: draft.amountArs.toFixed(2),
              residualArs: "0.00",
            },
          },
          tx,
        );
      }
      return result;
    });

  it("nueva key 123.01 persiste 123.01 exacto; replay idéntico no duplica fila", async () => {
    const user = await createTestUser(prisma);
    const draft = buildCashDraft(user.id, { amountArs: new Decimal("123.01") });

    const created = expectCashRecord(expectCreated(await submit(draft)));
    expect(created.amountArs.toFixed(2)).toBe("123.01");
    expect(created.priceArs?.toFixed(2)).toBe("1.00");

    const replayed = expectCashRecord(expectReplay(await submit(draft)));
    expect(replayed.id).toBe(created.id);
    expect(replayed.amountArs.toFixed(2)).toBe("123.01");
    const rows = await prisma.order.count({
      where: { userId: user.id, idempotencyKey: draft.idempotencyKey },
    });
    expect(rows).toBe(1);
  });

  it("misma key 123.01 vs 123.99 ⇒ CONFLICT (no colapsa por floor)", async () => {
    const user = await createTestUser(prisma);
    const draft = buildCashDraft(user.id, { amountArs: new Decimal("123.01") });
    const created = expectCreated(await submit(draft));

    const conflict = expectConflict(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: draft.idempotencyKey,
          amountArs: new Decimal("123.99"),
        }),
      ),
    );
    expect(conflict.id).toBe(created.id);
    expect(expectCashRecord(conflict).amountArs.toFixed(2)).toBe("123.01");
  });

  it("123.0 y 123.00 son el mismo monto ⇒ REPLAY", async () => {
    const user = await createTestUser(prisma);
    const draft = buildCashDraft(user.id, { amountArs: new Decimal("123.0") });
    const created = expectCreated(await submit(draft));

    const replayed = expectReplay(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: draft.idempotencyKey,
          amountArs: new Decimal("123.00"),
        }),
      ),
    );
    expect(replayed.id).toBe(created.id);
    expect(expectCashRecord(replayed).amountArs.toFixed(2)).toBe("123.00");
    // El replay no escribe auditoría nueva: sigue el evento de origen.
    expect(await prisma.orderEvent.count({ where: { orderId: created.id } })).toBe(1);
  });

  it("histórico 123.45/123: retry 123.00 (coincide con el size truncado) ⇒ CONFLICT", async () => {
    const user = await createTestUser(prisma);
    const key = randomUUID();
    const orderId = await seedCashOrder(prisma, user.id, {
      size: "123",
      idempotencyKey: key,
      events: [{ eventType: "ACCEPTED", metadata: { amountArs: "123.45" } }],
    });

    // 123.00 == size almacenado, pero NO es el pedido original documentado.
    const conflict = expectConflict(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: key,
          amountArs: new Decimal("123.00"),
        }),
      ),
    );
    expect(conflict.id).toBe(orderId);
    expect(expectCashRecord(conflict).amountArs.toFixed(2)).toBe("123.00");
    // Sin reescritura de la fila ni evento nuevo.
    expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(1);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.size?.toString()).toBe("123");
  });

  it.each([
    ["sin evento de origen", []],
    [
      "evidencia corrupta (amountArs no canónico)",
      [{ eventType: "ACCEPTED" as const, metadata: { amountArs: "123,45" } }],
    ],
  ])(
    "stored == retry (123.00) pero %s ⇒ CONFLICT conservador (sin bypass)",
    async (_label, events) => {
      const user = await createTestUser(prisma);
      const key = randomUUID();
      const orderId = await seedCashOrder(prisma, user.id, {
        size: "123",
        idempotencyKey: key,
        events,
      });

      const conflict = expectConflict(
        await submit(
          buildCashDraft(user.id, {
            idempotencyKey: key,
            amountArs: new Decimal("123.00"),
          }),
        ),
      );
      expect(conflict.id).toBe(orderId);
      expect(expectCashRecord(conflict).amountArs.toFixed(2)).toBe("123.00");
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(
        events.length,
      );
    },
  );

  it("primer evento de tipo no-decisión y uno posterior válido ⇒ CONFLICT (manda el origen)", async () => {
    const user = await createTestUser(prisma);
    const key = randomUUID();
    const orderId = await seedCashOrder(prisma, user.id, {
      size: "123",
      idempotencyKey: key,
      events: [
        { eventType: "FILLED", metadata: { amountArs: "123.00" } },
        { eventType: "ACCEPTED", metadata: { amountArs: "123.00" } },
      ],
    });

    const conflict = expectConflict(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: key,
          amountArs: new Decimal("123.00"),
        }),
      ),
    );
    expect(conflict.id).toBe(orderId);
    expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(2);
  });

  it("key histórica 123.45/123: retry 123.45 REPLAY fila 123.00 sin evento nuevo; 123.99 CONFLICT", async () => {
    const user = await createTestUser(prisma);
    const key = randomUUID();
    const orderId = await seedCashOrder(prisma, user.id, {
      size: "123",
      idempotencyKey: key,
      events: [{ eventType: "ACCEPTED", metadata: { amountArs: "123.45" } }],
    });

    const replayed = expectCashRecord(
      expectReplay(
        await submit(
          buildCashDraft(user.id, {
            idempotencyKey: key,
            amountArs: new Decimal("123.45"),
          }),
        ),
      ),
    );
    expect(replayed.id).toBe(orderId);
    // El movimiento original sigue siendo 123.00: NO se regalan los 0.45.
    expect(replayed.amountArs.toFixed(2)).toBe("123.00");
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(1);
    expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(1);

    const conflict = expectConflict(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: key,
          amountArs: new Decimal("123.99"),
        }),
      ),
    );
    expect(conflict.id).toBe(orderId);
    // El intento conflictivo tampoco escribió un evento.
    expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(1);
  });

  it("nueva key por 123.45 persiste 123.45 (no hereda el floor histórico)", async () => {
    const user = await createTestUser(prisma);
    const created = expectCashRecord(
      expectCreated(
        await submit(
          buildCashDraft(user.id, { amountArs: new Decimal("123.45") }),
        ),
      ),
    );
    expect(created.amountArs.toFixed(2)).toBe("123.45");
  });

  it.each([
    ["sin evento de origen", []],
    ["evento sin amountArs", [{ eventType: "ACCEPTED" as const, metadata: { ticker: "ARS" } }]],
    ["amountArs number (no string)", [{ eventType: "ACCEPTED" as const, metadata: { amountArs: 123.45 } }]],
    ["amountArs con 3 decimales", [{ eventType: "ACCEPTED" as const, metadata: { amountArs: "123.456" } }]],
    ["amountArs no numérico", [{ eventType: "ACCEPTED" as const, metadata: { amountArs: "abc" } }]],
    ["metadata array", [{ eventType: "ACCEPTED" as const, metadata: ["123.45"] }]],
  ])(
    "evidencia insuficiente/malformada (%s): retry 123.45 ⇒ CONFLICT conservador",
    async (_label, events) => {
      const user = await createTestUser(prisma);
      const key = randomUUID();
      await seedCashOrder(prisma, user.id, {
        size: "123",
        idempotencyKey: key,
        events,
      });

      expectConflict(
        await submit(
          buildCashDraft(user.id, {
            idempotencyKey: key,
            amountArs: new Decimal("123.45"),
          }),
        ),
      );
    },
  );

  it("no toma un evento POSTERIOR como evidencia del pedido original", async () => {
    const user = await createTestUser(prisma);
    const key = randomUUID();
    await seedCashOrder(prisma, user.id, {
      size: "123",
      idempotencyKey: key,
      events: [
        { eventType: "ACCEPTED", metadata: { ticker: "ARS" } },
        { eventType: "REJECTED", metadata: { amountArs: "123.45" } },
      ],
    });
    expectConflict(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: key,
          amountArs: new Decimal("123.45"),
        }),
      ),
    );
  });

  it("evidencia que no representa el floor guardado ⇒ CONFLICT", async () => {
    const user = await createTestUser(prisma);
    const key = randomUUID();
    await seedCashOrder(prisma, user.id, {
      size: "123",
      idempotencyKey: key,
      events: [{ eventType: "ACCEPTED", metadata: { amountArs: "200.00" } }],
    });
    expectConflict(
      await submit(
        buildCashDraft(user.id, {
          idempotencyKey: key,
          amountArs: new Decimal("200.00"),
        }),
      ),
    );
  });

  it.each([
    ["side", { side: "CASH_OUT" as const }],
    ["instrumento", { instrumentId: SEED_INSTRUMENT_PAMP_ID }],
    ["precio", { priceArs: new Decimal("2.00") }],
  ])(
    "cambio de %s en una key histórica ⇒ CONFLICT (aunque el monto coincida)",
    async (_label, overrides) => {
      const user = await createTestUser(prisma);
      const key = randomUUID();
      await seedCashOrder(prisma, user.id, {
        size: "123",
        idempotencyKey: key,
        events: [{ eventType: "ACCEPTED", metadata: { amountArs: "123.45" } }],
      });
      expectConflict(
        await submit(
          buildCashDraft(user.id, {
            idempotencyKey: key,
            amountArs: new Decimal("123.45"),
            ...overrides,
          }),
        ),
      );
    },
  );
});