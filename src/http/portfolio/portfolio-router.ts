// GET /api/users/:userId/portfolio (UC-1) — borde HTTP del caso de uso.
//
// Adaptador fino: Zod estricto sobre los params, getPortfolio y
// serialización al contrato. La agregación (cash, reservas, posiciones) es
// del caso de uso; acá no hay lógica de negocio.
//
// DECISIONS.md que el borde conserva:
//  - cash disponible = cashSettled − cashReserved (deriveCash NO mira
//    reservas; la resta es de la capa de aplicación);
//  - sin precio de referencia (NO_PRICE): marketValue null,
//    priceAvailable false, totalReturnPct null y la posición NO suma al
//    totalAccountValue (las negativas SÍ restan);
//  - posición con cantidad 0 no se lista (la oculta derivePositions);
//  - MONEDA nunca llega: no es posición derivable de BUY/SELL.

import { Router } from "express";
import type { Request, Response } from "express";
import { getPortfolio } from "../../application/portfolio/get-portfolio.js";
import type { PortfolioState } from "../../application/portfolio/get-portfolio.js";
import {
  API_ERROR_CODES,
  PortfolioParamsSchema,
  apiErrorBody,
  serializeMoneyArs,
  serializePct,
  serializeQuantityShares,
} from "../../contracts/index.js";
import type { PortfolioResponse } from "../../contracts/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  PortfolioReadRepository,
} from "../../domain/ports/index.js";
import { validationMessage } from "../shared/edge.js";

/** Deps del slice de portfolio: interfaces de src/domain/ports. */
export interface PortfolioRouterDeps {
  /** Lado de lectura del portfolio (userExists resuelve el 404). */
  readonly portfolioRead: PortfolioReadRepository;
  /** Precios de referencia: UN batch de snapshots (getLatestSnapshots). */
  readonly marketdata: MarketdataRepository;
  /** ticker/name de cada posición derivada, en UN batch (findByIds). */
  readonly instruments: InstrumentRepository;
}

/** Estado de dominio → contrato HTTP (dinero y porcentajes a 2 decimales). */
const toPortfolioResponse = (
  portfolio: PortfolioState,
): PortfolioResponse => ({
  cash: serializeMoneyArs(portfolio.cashArs),
  reservedCash: serializeMoneyArs(portfolio.reservedCashArs),
  totalAccountValue: serializeMoneyArs(portfolio.totalAccountValueArs),
  positions: portfolio.positions.map((position) => ({
    ticker: position.ticker,
    name: position.name,
    // bigint interno → string entero canónico (JSON no representa bigint).
    quantity: serializeQuantityShares(position.quantityShares),
    marketValue:
      position.marketValueArs === null
        ? null
        : serializeMoneyArs(position.marketValueArs),
    priceAvailable: position.priceAvailable,
    totalReturnPct:
      position.totalReturnPctX100 === null
        ? null
        : serializePct(position.totalReturnPctX100),
  })),
});

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

      const result = await getPortfolio(deps, userId);
      if (result.kind === "USER_NOT_FOUND") {
        res.status(404).json(
          apiErrorBody(
            API_ERROR_CODES.USER_NOT_FOUND,
            `No existe el usuario ${userId}.`,
          ),
        );
        return;
      }

      res.status(200).json(toPortfolioResponse(result.portfolio));
    },
  );

  return router;
};
