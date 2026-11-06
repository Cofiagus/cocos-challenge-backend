// Integración (DB real: cocos_challenge_test) + tx simulada — caracterización
// de PrismaOrderRepository.createOrder: persistencia decimal del cash y ramas
// que el SQL real no puede producir (count del claim fuera de {0,1}, fila
// ausente tras el claim). La comparación de identidad del request vive en
// `tests/unit/infra/request-comparison.test.ts` (función pura, sin DB).
//
// Prerequisito: `npm run test:db:reset` antes de la suite.

import { config } from "dotenv";

config({ path: ".env.test" });

import { FinancialDecimal } from "../../../src/contracts/index.js";
import type {
  OrderDraft,
  TransactionContext,
} from "../../../src/contracts/index.js";
import { CorruptRowError } from "../../../src/infra/prisma/corrupt-row.error.js";
import { PrismaOrderRepository } from "../../../src/infra/prisma/order-repository.js";
import { getPrismaClient } from "../../../src/lib/prisma-client.js";
import { createTestUser } from "../../helpers/factories.js";
import { SEED_INSTRUMENT_ARS_ID } from "../../helpers/fixtures.js";
import {
  buildCashDraft,
  buildDraft,
  expectCashRecord,
  expectCreated,
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

// Los tres casos de `price` NULL (fila no-NULL/draft NULL, fila NULL/draft
// no-NULL y NULL en ambos lados) se mudaron a
// `tests/unit/infra/request-comparison.test.ts`: con el CHECK
// `LIMIT ⇒ price NOT NULL` ya no se puede persistir una fila LIMIT sin
// precio, y la comparación pura cubre la MISMA matriz sin DB.

describe("PrismaOrderRepository.createOrder — persistencia decimal cash (DB real)", () => {
  const prisma = getPrismaClient();
  const orderRepo = new PrismaOrderRepository();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const submit = (draft: OrderDraft) =>
    orderRepo.withUserTransaction(draft.userId, (tx) =>
      orderRepo.createOrder(draft, tx),
    );

  it.each(["0.01", "9999999999999999999999.99"])(
    "monto cash %s: INSERT conserva el Decimal exacto con precio 1.00",
    async (amount) => {
      const user = await createTestUser(prisma);
      const created = expectCashRecord(
        expectCreated(
          await submit(
            buildCashDraft(user.id, {
              amountArs: new FinancialDecimal(amount),
              idempotencyKey: null,
            }),
          ),
        ),
      );
      expect(created.amountArs.toFixed(2)).toBe(amount);
      expect(created.priceArs?.toFixed(2)).toBe("1.00");

      // Lectura DIRECTA de la columna física: mismo texto, sin Number de por medio.
      const raw = await prisma.order.findUnique({ where: { id: created.id } });
      expect(raw?.size?.toFixed(2)).toBe(amount);
      expect(raw?.price?.toString()).toBe("1");
      expect(raw?.side).toBe("CASH_IN");
      expect(raw?.instrumentId).toBe(SEED_INSTRUMENT_ARS_ID);
    },
  );

  it("ZERO_SIZE cash histórico (size 0 REJECTED) se mapea 0.00 sin regalar centavos", async () => {
    const user = await createTestUser(prisma);
    const row = await prisma.order.create({
      data: {
        userId: user.id,
        instrumentId: SEED_INSTRUMENT_ARS_ID,
        side: "CASH_IN",
        type: "MARKET",
        timeInForce: "GTC",
        status: "REJECTED",
        size: "0",
        price: "1.00",
        datetime: new Date(),
      },
    });
    const found = expectCashRecord(
      (await orderRepo.findById(row.id)) ?? (() => {
        throw new Error("fila REJECTED no encontrada");
      })(),
    );
    expect(found.amountArs.toFixed(2)).toBe("0.00");
    expect(found.status).toBe("REJECTED");
  });

  it("cash con size NULL (columna legacy) ⇒ CorruptRowError ruidoso al leer", async () => {
    const user = await createTestUser(prisma);
    const row = await prisma.order.create({
      data: {
        userId: user.id,
        instrumentId: SEED_INSTRUMENT_ARS_ID,
        side: "CASH_IN",
        type: "MARKET",
        timeInForce: "GTC",
        status: "FILLED",
        size: null,
        price: "1.00",
        // El CHECK `FILLED ⇒ filledPrice NOT NULL` es del head versionado:
        // la fila caracterizada es legacy por el `size`, no por el precio.
        filledPrice: "1.00",
        datetime: new Date(),
      },
    });
    await expect(orderRepo.findById(row.id)).rejects.toThrow(CorruptRowError);
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
