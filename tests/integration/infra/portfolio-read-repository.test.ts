// Integración (DB real: cocos_challenge_test) — PrismaPortfolioReadRepository
// contra el SEED: golden values de reservas/cash (user 1) y tx opcional.
//
// Prerequisito: `npm run test:db:reset` antes de la suite (los golden values
// son del seed: 2 órdenes NEW del user 1, cashSettled 753000.00).

import { config } from "dotenv";

config({ path: ".env.test" });

import { FinancialDecimal } from "../../../src/contracts/index.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { PrismaPortfolioReadRepository } from "../../../src/infra/prisma/portfolio-read-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { createTestUser } from "../../helpers/factories.js";
import {
  SEED_USER_EMILIANO_ID,
  SEED_USER_1_PORTFOLIO,
} from "../../helpers/fixtures.js";
import { buildDraft } from "./support.js";

describe("PrismaPortfolioReadRepository — lecturas de portfolio (DB real)", () => {
  const prisma = getPrismaClient();
  const readRepo = new PrismaPortfolioReadRepository();
  const orderRepo = new PrismaOrderRepository();

  afterAll(async () => {
    // Cierre ordenado del pool del adapter para que el worker de jest termine limpio.
    await prisma.$disconnect();
  });

  it("userExists: id del seed existe, id inexistente no", async () => {
    expect(await readRepo.userExists(SEED_USER_EMILIANO_ID)).toBe(true);
    expect(await readRepo.userExists(999999999)).toBe(false);
  });

  it("listRestingOrders(user 1) ⇒ las 2 resting del seed y reservas golden 125500.00", async () => {
    const resting = await readRepo.listRestingOrders(SEED_USER_EMILIANO_ID);
    // Seed: order 5 (LOMA BUY 50 @ 710.00) + order 7 (BMA BUY 60 @ 1500.00).
    expect(resting).toHaveLength(2);
    expect(resting.every((order) => order.side === "BUY")).toBe(true);

    // Reservas derivadas (DECISIONS.md: Σ limit × size de BUY NEW).
    const cashReserved = resting.reduce(
      (acc, order) => acc.add(order.limitPriceArs.mul(order.sizeShares)),
      new FinancialDecimal(0),
    );
    expect(cashReserved.toFixed(2)).toBe(SEED_USER_1_PORTFOLIO.cashReservedArs);
    // sanity del detalle: 50×710 + 60×1500 = 125500
    expect(
      resting
        .map((order) => `${order.instrumentId}:${order.limitPriceArs.toFixed(2)}x${order.sizeShares}`)
        .sort(),
    ).toEqual(["31:1500.00x60", "45:710.00x50"]);
  });

  it("listSettledMovements(user 1) ⇒ movimientos FILLED que derivan el cash golden 753000.00", async () => {
    const movements = await readRepo.listSettledMovements(SEED_USER_EMILIANO_ID);
    // Seed del user 1 FILLED: ids 1,2,4,8,9,10,11 (7 filas, CASH_* incluidas).
    expect(movements.length).toBeGreaterThanOrEqual(7);
    const cashMovements = movements.filter(
      (movement) => movement.side === "CASH_IN" || movement.side === "CASH_OUT",
    );
    expect(cashMovements).toHaveLength(2);

    // cash = Σ CASH_IN/SELL monto − Σ CASH_OUT/BUY monto
    // (docs/database.md §3 — cálculo de test, el de producción es del dominio).
    // D2/D3: cash aporta amountArs; trading aporta priceArs × sizeShares.
    const cashSettled = movements.reduce((acc, movement) => {
      switch (movement.side) {
        case "CASH_IN":
          return acc.add(movement.amountArs);
        case "CASH_OUT":
          return acc.sub(movement.amountArs);
        case "SELL":
          return acc.add(movement.priceArs.mul(movement.sizeShares));
        case "BUY":
          return acc.sub(movement.priceArs.mul(movement.sizeShares));
      }
    }, new FinancialDecimal(0));
    expect(cashSettled.toFixed(2)).toBe(SEED_USER_1_PORTFOLIO.cashSettledArs);
  });

  it("usuario nuevo ⇒ sin movimientos ni resting (y no explota)", async () => {
    const user = await createTestUser(prisma);
    expect(await readRepo.userExists(user.id)).toBe(true);
    expect(await readRepo.listSettledMovements(user.id)).toEqual([]);
    expect(await readRepo.listRestingOrders(user.id)).toEqual([]);
  });

  it("tx opcional: mismas lecturas dentro de withUserTransaction que con cliente root", async () => {
    const user = await createTestUser(prisma);
    // una resting + una FILLED propias del usuario
    await orderRepo.withUserTransaction(user.id, async (tx) => {
      await orderRepo.createOrder(buildDraft(user.id), tx);
      await orderRepo.createOrder(
        buildDraft(user.id, {
          type: "MARKET",
          status: "FILLED",
          priceArs: null,
          filledPriceArs: new FinancialDecimal("925.85"),
        }),
        tx,
      );
    });

    const rootResting = await readRepo.listRestingOrders(user.id);
    const txResting = await orderRepo.withUserTransaction(user.id, (tx) =>
      readRepo.listRestingOrders(user.id, tx),
    );
    expect(txResting.map((order) => order.id)).toEqual(
      rootResting.map((order) => order.id),
    );
    expect(rootResting).toHaveLength(1);

    const txExists = await orderRepo.withUserTransaction(user.id, (tx) =>
      readRepo.userExists(user.id, tx),
    );
    expect(txExists).toBe(true);
    const txMissing = await orderRepo.withUserTransaction(user.id, (tx) =>
      readRepo.userExists(999999999, tx),
    );
    expect(txMissing).toBe(false);
  });
});