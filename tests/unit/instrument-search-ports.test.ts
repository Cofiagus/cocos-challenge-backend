// Contrato de los seams compartidos de UC-2 (búsqueda con cotizaciones
// actuales): fuente de cotización inyectable y offset interno del catálogo.
// SIN DB ni red: fake de InstrumentQuoteSource y fake ESTRICTO de PrismaClient
// (unknown + narrowing/cast tipado, sin any).
//
// Dinero del port: FinancialDecimal (precisión 64 del proyecto), construido
// desde strings — NO el `Decimal` base de decimal.js (D1, main).

import type { PrismaClient } from "@prisma/client";
import {
  FinancialDecimal,
  MarketDataServiceUnavailableError,
} from "../../src/contracts/index.js";
import type {
  InstrumentQuote,
  InstrumentQuoteSource,
} from "../../src/domain/ports/index.js";
import { PrismaInstrumentRepository } from "../../src/infra/prisma/instrument-repository.js";

const MARKET_DATA_ERROR_MESSAGE =
  "El servicio de cotizaciones (Yahoo Finance) no está disponible. Intentá nuevamente más tarde.";

/** Construye un fake mínimo que satisface el port inyectable. */
const buildQuoteSource = (
  getCurrentQuote: InstrumentQuoteSource["getCurrentQuote"],
): InstrumentQuoteSource => ({ getCurrentQuote });

describe("InstrumentQuoteSource — contrato inyectable", () => {
  it("devuelve precio y cierre previo como FinancialDecimal construidos desde strings", async () => {
    const quote: InstrumentQuote = {
      priceArs: new FinancialDecimal("123.45"),
      previousCloseArs: new FinancialDecimal("120.00"),
    };
    const source = buildQuoteSource(async (ticker) =>
      ticker === "PAMP" ? quote : null,
    );

    const result = await source.getCurrentQuote("PAMP");

    expect(result).not.toBeNull();
    expect(result?.priceArs).toBeInstanceOf(FinancialDecimal);
    expect(result?.priceArs.toString()).toBe("123.45");
    expect(result?.previousCloseArs).toBeInstanceOf(FinancialDecimal);
    expect(result?.previousCloseArs.toString()).toBe("120");
  });

  it("conserva la precisión de 64 cifras del constructor financiero", async () => {
    const source = buildQuoteSource(async () => ({
      priceArs: new FinancialDecimal("90071992547409.93"),
      previousCloseArs: new FinancialDecimal("90071992547400.00"),
    }));

    const result = await source.getCurrentQuote("PAMP");

    // Un number habría devuelto ...94: el port no pierde el centavo.
    expect(result?.priceArs.toFixed(2)).toBe("90071992547409.93");
    expect(FinancialDecimal.precision).toBe(64);
  });

  it("null = ticker sin cotización computable, NO falla del servicio", async () => {
    const source = buildQuoteSource(async () => null);

    await expect(source.getCurrentQuote("SIN-COTIZACION")).resolves.toBeNull();
  });

  it("una falla de disponibilidad se distingue de null y conserva name/message exactos", async () => {
    const source = buildQuoteSource(async () => {
      throw new MarketDataServiceUnavailableError();
    });

    await expect(source.getCurrentQuote("PAMP")).rejects.toBeInstanceOf(
      MarketDataServiceUnavailableError,
    );

    const error = new MarketDataServiceUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MarketDataServiceUnavailableError");
    expect(error.message).toBe(MARKET_DATA_ERROR_MESSAGE);
  });
});

/** Fila mínima que mapInstrumentRow consume del catálogo. */
interface FakeInstrumentRow {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly type: string;
}

/** Args de findMany que el repo arma: se capturan para verificar limit/offset. */
interface InstrumentFindManyArgs {
  readonly where: {
    readonly OR: readonly [
      { readonly ticker: { readonly contains: string; readonly mode: string } },
      { readonly name: { readonly contains: string; readonly mode: string } },
    ];
    readonly NOT: {
      readonly type: { readonly equals: string; readonly mode: string };
    };
  };
  readonly orderBy: { readonly ticker: "asc" };
  readonly take: number;
  readonly skip: number;
}

const FAKE_ROWS: readonly FakeInstrumentRow[] = [
  { id: 47, ticker: "PAMP", name: "Pampa Holding S.A.", type: "ACCIONES" },
];

/** Fake ESTRICTO: sólo el delegado instrument.findMany que usa el repo. */
const buildFakeClient = (): {
  readonly client: PrismaClient;
  readonly calls: readonly InstrumentFindManyArgs[];
} => {
  const calls: InstrumentFindManyArgs[] = [];
  const findMany = async (
    args: InstrumentFindManyArgs,
  ): Promise<readonly FakeInstrumentRow[]> => {
    calls.push(args);
    return FAKE_ROWS;
  };
  // Cast tipado en el borde: el repo sólo invoca instrument.findMany.
  const client = { instrument: { findMany } } as unknown as PrismaClient;
  return { client, calls };
};

describe("PrismaInstrumentRepository — offset interno del catálogo", () => {
  it("sin offset ⇒ take=limit y skip=0 por defecto (misma query/orden/filtro)", async () => {
    const { client, calls } = buildFakeClient();
    const repository = new PrismaInstrumentRepository(client);

    const result = await repository.searchByQuery("pam", 10);

    expect(result).toEqual(FAKE_ROWS);
    expect(calls).toHaveLength(1);
    const [args] = calls;
    expect(args?.take).toBe(10);
    expect(args?.skip).toBe(0);
    expect(args?.orderBy).toEqual({ ticker: "asc" });
    expect(args?.where).toEqual({
      OR: [
        { ticker: { contains: "pam", mode: "insensitive" } },
        { name: { contains: "pam", mode: "insensitive" } },
      ],
      NOT: { type: { equals: "MONEDA", mode: "insensitive" } },
    });
  });

  it("offset explícito se traduce a skip y conserva take", async () => {
    const { client, calls } = buildFakeClient();
    const repository = new PrismaInstrumentRepository(client);

    await repository.searchByQuery("pam", 5, 20);

    const [args] = calls;
    expect(args?.take).toBe(5);
    expect(args?.skip).toBe(20);
  });

  it("offset undefined explícito también cae a 0", async () => {
    const { client, calls } = buildFakeClient();
    const repository = new PrismaInstrumentRepository(client);

    await repository.searchByQuery("pam", 7, undefined);

    const [args] = calls;
    expect(args?.take).toBe(7);
    expect(args?.skip).toBe(0);
  });
});
