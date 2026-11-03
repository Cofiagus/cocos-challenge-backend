// UC-1 — GET /api/users/:userId/portfolio.
//
// Router factory con DI (patrón buildApp de src/http/app.ts): las
// dependencias son las INTERFACES de src/domain/ports — jamás una
// implementación concreta. El handler NO tiene lógica de negocio: es
// Zod (borde) → repos → dominio → serialización
// del contrato. La AGREGACIÓN (cash, reservas, posiciones) la hacen las
// funciones PURAS de src/domain/portfolio sobre las listas de los repos.
//
// DECISIONS.md:
//  - cash disponible = cashSettled − cashReserved (deriveCash NO mira
//    reservas; la resta es de esta capa);
//  - sin precio de referencia (NO_PRICE): marketValue null,
//    priceAvailable false, totalReturnPct null y la posición NO suma
//    al totalAccountValue (las negativas SÍ restan);
//  - posición con cantidad 0 no se lista (la oculta derivePositions);
//  - MONEDA nunca llega: no es posición derivable de BUY/SELL.

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  API_ERROR_CODES,
  PortfolioParamsSchema,
  apiErrorBody,
  serializeMoneyArs,
  serializePct,
} from "../../contracts/index.js";
import type { PortfolioPosition, PortfolioResponse } from "../../contracts/index.js";
import {
  deriveCash,
  derivePositions,
  deriveReservations,
} from "../../domain/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";

/** Deps del slice de portfolio: interfaces de src/domain/ports. */
export interface PortfolioRouterDeps {
  /** Lado de lectura del portfolio (userExists resuelve el 404). */
  readonly portfolioRead: PortfolioReadRepository;
  /** Precios de referencia: UN batch de snapshots (getLatestSnapshots). */
  readonly marketdata: MarketdataRepository;
  /** ticker/name de cada posición derivada. */
  readonly instruments: InstrumentRepository;
}

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

export const buildPortfolioRouter = (deps: PortfolioRouterDeps): Router => {
  const router = Router();

  router.get(
    "/users/:userId/portfolio",
    async (req: Request, res: Response) => {
      // Borde: Zod estricto sobre los params, sin cast.
      const params = PortfolioParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(
          apiErrorBody(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Parámetros inválidos: ${validationMessage(params.error)}`,
          ),
        );
        return;
      }
      const { userId } = params.data;

      // 404 de usuario inexistente (userExists del port de lectura).
      const userExists = await deps.portfolioRead.userExists(userId);
      if (!userExists) {
        res.status(404).json(
          apiErrorBody(
            API_ERROR_CODES.USER_NOT_FOUND,
            `No existe el usuario ${userId}.`,
          ),
        );
        return;
      }

      // Lecturas del port: movimientos FILLED y órdenes NEW (reservas).
      // Secuenciales (no Promise.all): Prisma no documenta queries paralelas
      // sobre una misma sesión/tx interactiva, y dos SELECT no ganan nada
      // medible en paralelo.
      // Eventual consistency aceptable: son queries INDEPENDIENTES — un
      // submit que comitee entre ambas produce un snapshot no puntual
      // (cash descontado sin su reserva). Este endpoint es informativo; los
      // writes se validan dentro de withUserTransaction (lock por usuario),
      // así que esto NO habilita double-spend. No se envuelven en una tx
      // (cambiaría el comportamiento de lectura).
      const movements = await deps.portfolioRead.listSettledMovements(userId);
      const restingOrders = await deps.portfolioRead.listRestingOrders(userId);

      // UN batch de snapshots de los instrumentos que PUEDEN tener
      // posición (BUY/SELL FILLED): getLatestSnapshots del port, sin N+1.
      // CASH_IN/CASH_OUT no son posiciones: quedan fuera del batch.
      const tradedInstrumentIds = [
        ...new Set(
          movements
            .filter(
              (movement) =>
                movement.side === "BUY" || movement.side === "SELL",
            )
            .map((movement) => movement.instrumentId),
        ),
      ];
      const snapshots =
        await deps.marketdata.getLatestSnapshots(tradedInstrumentIds);

      // Agregación: DOMINIO PURO sobre los datos de los repos.
      const cashSettled = deriveCash(movements);
      const reservations = deriveReservations(restingOrders);
      const positions = derivePositions(movements, snapshots);

      // Cash disponible = cashSettled − cashReserved (DECISIONS.md).
      const cash = cashSettled.minus(reservations.cashReservedArs);

      // Serialización de las posiciones: ticker/name del catálogo
      // (PositionPnl sólo trae instrumentId).
      // N+1 acotado: N = posiciones del usuario (seed: 3). Si el catálogo o
      // el usuario crecen, el fix es un batch findByIds en el port de
      // instrumentos (cambio de port no pedido acá).
      const serializedPositions: PortfolioPosition[] = await Promise.all(
        positions.map(async (position) => {
          const instrument = await deps.instruments.findById(
            position.instrumentId,
          );
          if (instrument === null) {
            // Orden FILLED cuyo instrumento no existe: corrupción de
            // datos — falla ruidosa, nunca se omite en silencio.
            throw new Error(
              `Instrumento ${position.instrumentId} de la posición no existe (orden huérfana).`,
            );
          }
          return {
            ticker: instrument.ticker,
            name: instrument.name,
            quantity: position.quantityShares,
            marketValue:
              position.marketValueArs === null
                ? null
                : serializeMoneyArs(position.marketValueArs),
            priceAvailable: position.priceAvailable,
            totalReturnPct:
              position.totalReturnPctX100 === null
                ? null
                : serializePct(position.totalReturnPctX100),
          };
        }),
      );

      // totalAccountValue = cash + Σ marketValue de las posiciones CON
      // precio (las null NO suman; las negativas SÍ restan — BMA del seed).
      const totalAccountValue = positions.reduce(
        (acc, position) =>
          position.marketValueArs === null
            ? acc
            : acc.add(position.marketValueArs),
        cash,
      );

      const body: PortfolioResponse = {
        cash: serializeMoneyArs(cash),
        reservedCash: serializeMoneyArs(reservations.cashReservedArs),
        totalAccountValue: serializeMoneyArs(totalAccountValue),
        positions: serializedPositions,
      };
      res.status(200).json(body);
    },
  );

  return router;
};