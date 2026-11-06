// Integración (DB real: cocos_challenge_test) — la transacción de envío de
// PrismaOrderRepository: pg_advisory_xact_lock por usuario como PRIMERA
// sentencia (DECISIONS.md), auditoría en la MISMA tx y guards de estado
// en markFilled/markCancelled (WHERE status='NEW').
//
// Prerequisito: `npm run test:db:reset` antes de la suite.

import { config } from "dotenv";

config({ path: ".env.test" });

import { FinancialDecimal } from "../../../src/contracts/index.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { createTestOrder, createTestUser } from "../../helpers/factories.js";
import { SEED_INSTRUMENT_PAMP_ID } from "../../helpers/fixtures.js";
import { buildCashDraft, buildDraft, expectCreated, sleep } from "./support.js";

describe("PrismaOrderRepository — transacción de envío (DB real)", () => {
  const prisma = getPrismaClient();
  const orderRepo = new PrismaOrderRepository();
  const readRepo = new PrismaPortfolioReadRepository();

  afterAll(async () => {
    // Cierre ordenado del pool del adapter para que el worker de jest termine limpio.
    await prisma.$disconnect();
  });

  it("withUserTransaction serializa por usuario: el segundo VE el efecto del primero dentro de su tx", async () => {
    const user = await createTestUser(prisma);

    // Gate DETERMINÍSTICO (sin carrera de scheduling): op2 no arranca su tx
    // hasta que op1 insertó dentro de la SUYA — lo que garantiza que op1
    // tomó el advisory lock primero y op2 puede adquirirlo sólo tras el
    // COMMIT de op1 (pg_advisory_xact_lock se libera al commit).
    let signalOp1Inserted!: () => void;
    const op1Inserted = new Promise<void>((resolve) => {
      signalOp1Inserted = resolve;
    });

    // op1 toma el lock, inserta una resting, señala y MANTIENE la tx
    // abierta 400ms más (el efecto aún no está commiteado).
    const op1 = orderRepo.withUserTransaction(user.id, async (tx) => {
      const created = await orderRepo.createOrder(buildDraft(user.id), tx);
      expectCreated(created);
      signalOp1Inserted();
      await sleep(400);
    });

    const t0 = Date.now();
    // op2 (concurrente): su PRIMERA sentencia es el advisory lock ⇒ se
    // BLOQUEA hasta el commit de op1; su lectura DENTRO de su tx ve la
    // orden de op1 — el efecto observable de la serialización.
    const op2 = op1Inserted.then(() =>
      orderRepo.withUserTransaction(user.id, async (tx) => {
        const resting = await readRepo.listRestingOrders(user.id, tx);
        return {
          acquiredAfterMs: Date.now() - t0,
          restingCount: resting.length,
        };
      }),
    );

    const observed = await op2;
    await op1;

    expect(observed.restingCount).toBe(1);
    // El lock de op2 lo adquirió ~400ms después de empezar su tx: esperó
    // al commit de op1, no corrió en paralelo.
    expect(observed.acquiredAfterMs).toBeGreaterThanOrEqual(250);
  });

  it("withUserTransaction devuelve el valor de operation (y distintas tx del mismo usuario se serializan sin deadlock)", async () => {
    const user = await createTestUser(prisma);
    const result = await orderRepo.withUserTransaction(user.id, async () => "retorno");
    expect(result).toBe("retorno");
  });

  // -----------------------------------------------------------------------
  // Auditoría append-only, MISMA tx
  // -----------------------------------------------------------------------

  it("appendOrderEvent inserta en la MISMA tx y hace round-trip del evento", async () => {
    const user = await createTestUser(prisma);
    const event = await orderRepo.withUserTransaction(user.id, async (tx) => {
      const created = await orderRepo.createOrder(buildDraft(user.id), tx);
      return orderRepo.appendOrderEvent(
        {
          orderId: created.order.id,
          eventType: "ACCEPTED",
          reason: null,
          metadata: { source: "integration-test" },
        },
        tx,
      );
    });

    expect(event.eventType).toBe("ACCEPTED");
    expect(event.reason).toBeNull();
    expect(event.metadata).toEqual({ source: "integration-test" });

    const rows = await prisma.orderEvent.findMany({
      where: { orderId: event.orderId },
    });
    expect(rows).toHaveLength(1);
  });

  it("appendOrderEvent con metadata null y reason NO_IMMEDIATE_MATCH (payload de cancelación)", async () => {
    const user = await createTestUser(prisma);
    const event = await orderRepo.withUserTransaction(user.id, async (tx) => {
      const created = await orderRepo.createOrder(
        buildDraft(user.id, { timeInForce: "IOC", status: "CANCELLED" }),
        tx,
      );
      return orderRepo.appendOrderEvent(
        {
          orderId: created.order.id,
          eventType: "CANCELLED",
          reason: "NO_IMMEDIATE_MATCH",
          metadata: null,
        },
        tx,
      );
    });
    expect(event.reason).toBe("NO_IMMEDIATE_MATCH");
    expect(event.metadata).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Guards de estado (WHERE status='NEW')
  // -----------------------------------------------------------------------

  it("markFilled sobre NEW ⇒ FILLED con precio/fecha de ejecución", async () => {
    const user = await createTestUser(prisma);
    const created = expectCreated(
      await orderRepo.withUserTransaction(user.id, (tx) =>
        orderRepo.createOrder(buildDraft(user.id), tx),
      ),
    );
    const filledAt = new Date("2023-07-14T15:00:00.000Z");
    const filled = await orderRepo.withUserTransaction(user.id, (tx) =>
      orderRepo.markFilled(created.id, new FinancialDecimal("925.85"), filledAt, tx),
    );
    expect(filled?.status).toBe("FILLED");
    expect(filled?.filledPriceArs?.toFixed(2)).toBe("925.85");
    expect(filled?.filledAt?.toISOString()).toBe(filledAt.toISOString());
    // el límite queda intacto (price = límite enviado, filledPrice = ejecución)
    expect(filled?.priceArs?.toFixed(2)).toBe("930.00");
  });

  it("markFilled sobre FILLED ⇒ null y NO muta (guard por estado)", async () => {
    const user = await createTestUser(prisma);
    const seedFilled = await createTestOrder(prisma, {
      userId: user.id,
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      type: "MARKET",
      status: "FILLED",
      priceArs: "930.00",
      size: 10,
    });
    const result = await orderRepo.withUserTransaction(user.id, (tx) =>
      orderRepo.markFilled(seedFilled.id, new FinancialDecimal("111.11"), new Date(), tx),
    );
    expect(result).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: seedFilled.id } });
    expect(after?.status).toBe("FILLED");
    // La fila nace FILLED con `price` = ejecución: el trigger de
    // db_write_invariants normaliza `filledPrice` YA en el INSERT (no puede
    // quedar NULL). El guard no muta nada: conserva el precio de la fila y no
    // el 111.11 del intento, y `filledAt` sigue NULL.
    expect(after?.filledPrice?.toString()).toBe("930");
    expect(after?.filledAt).toBeNull();
  });

  it("markCancelled sobre NEW ⇒ CANCELLED; sobre CANCELLED ⇒ null (idempotente)", async () => {
    const user = await createTestUser(prisma);
    const created = expectCreated(
      await orderRepo.withUserTransaction(user.id, (tx) =>
        orderRepo.createOrder(buildDraft(user.id), tx),
      ),
    );
    const cancelled = await orderRepo.withUserTransaction(user.id, (tx) =>
      orderRepo.markCancelled(created.id, tx),
    );
    expect(cancelled?.status).toBe("CANCELLED");

    // Ya no está NEW: el guard devuelve null sin mutar.
    const second = await orderRepo.withUserTransaction(user.id, (tx) =>
      orderRepo.markCancelled(created.id, tx),
    );
    expect(second).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe("CANCELLED");
  });

  it("markCancelled sobre FILLED ⇒ null y no muta", async () => {
    const user = await createTestUser(prisma);
    const filled = await createTestOrder(prisma, {
      userId: user.id,
      instrumentId: SEED_INSTRUMENT_PAMP_ID,
      type: "MARKET",
      status: "FILLED",
      priceArs: "930.00",
      size: 10,
    });
    const result = await orderRepo.withUserTransaction(user.id, (tx) =>
      orderRepo.markCancelled(filled.id, tx),
    );
    expect(result).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: filled.id } });
    expect(after?.status).toBe("FILLED");
  });

  it("findById mapea la fila completa (lectura suelta, cliente root)", async () => {
    const user = await createTestUser(prisma);
    const created = expectCreated(
      await orderRepo.withUserTransaction(user.id, (tx) =>
        orderRepo.createOrder(
          buildDraft(user.id, {
            status: "FILLED",
            filledPriceArs: new FinancialDecimal("925.85"),
            filledAt: new Date("2023-07-14T16:00:00.000Z"),
          }),
          tx,
        ),
      ),
    );
    const found = await orderRepo.findById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.userId).toBe(user.id);
    expect(found?.timeInForce).toBe("GTC");
    expect(found?.filledPriceArs?.toFixed(2)).toBe("925.85");
    expect(await orderRepo.findById(999999999)).toBeNull();
  });

  it("rollback de una multi-escritura cash no deja orden ni evento", async () => {
    const user = await createTestUser(prisma);
    const key = `rollback-${user.id}`;

    await expect(
      orderRepo.withUserTransaction(user.id, async (tx) => {
        const created = expectCreated(
          await orderRepo.createOrder(
            buildCashDraft(user.id, {
              amountArs: new FinancialDecimal("10.01"),
              idempotencyKey: key,
            }),
            tx,
          ),
        );
        await orderRepo.appendOrderEvent(
          {
            orderId: created.id,
            eventType: "ACCEPTED",
            reason: null,
            metadata: { amountArs: "10.01" },
          },
          tx,
        );
        throw new Error("falla simulada después de escribir");
      }),
    ).rejects.toThrow("falla simulada después de escribir");

    expect(
      await prisma.order.count({ where: { userId: user.id, idempotencyKey: key } }),
    ).toBe(0);
    expect(await prisma.orderEvent.count({ where: { order: { userId: user.id } } })).toBe(0);
  });
});