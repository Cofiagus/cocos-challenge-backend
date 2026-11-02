import { PrismaClient } from '@prisma/client';

export interface PortfolioPosition {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  avgPrice: number;
  marketPrice: number | null;
  marketPriceDate: string | null;
  marketValue: number;
  unrealizedPnl: number;
}

export interface PortfolioCash {
  userId: number;
  cash: number;
  cashReserved: number;
}

export interface PortfolioData {
  userId: number;
  cash: PortfolioCash;
  positions: PortfolioPosition[];
  totalValue: number;
  totalUnrealizedPnl: number;
}

export class PortfolioService {
  constructor(private prisma: PrismaClient) {}

  async getPortfolio(userId: number): Promise<PortfolioData> {
    const cash = await this.getCashBalance(userId);
    const positions = await this.getPositions(userId);
    
    const totalValue = cash.cash + positions.reduce((sum, pos) => sum + pos.marketValue, 0);
    const totalUnrealizedPnl = positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);

    return {
      userId,
      cash,
      positions,
      totalValue,
      totalUnrealizedPnl
    };
  }

  async getPortfolioWithDetails(userId: number): Promise<PortfolioData> {
    return this.getPortfolio(userId);
  }

  private async getCashBalance(userId: number): Promise<PortfolioCash> {
    const cashQuery = `
      SELECT 
        :userId as userId,
        coalesce(sum(CASE 
          WHEN side IN ('CASH_IN', 'SELL') THEN size * price
          WHEN side IN ('CASH_OUT', 'BUY') THEN -size * price
        END), 0)::numeric(14,2) as cash,
        coalesce(sum(CASE 
          WHEN status = 'NEW' AND side = 'BUY' THEN size * price
          ELSE 0
        END), 0)::numeric(14,2) as cash_reserved
      FROM orders
      WHERE userid = :userId AND status = 'FILLED'
    `;

    const result = await this.prisma.$queryRawUnsafe(cashQuery, { userId });
    return result[0] as PortfolioCash;
  }

  private async getPositions(userId: number): Promise<PortfolioPosition[]> {
    const positionsQuery = `
      WITH last_price AS (
        SELECT DISTINCT ON (instrumentid) instrumentid, date, close
        FROM marketdata
        ORDER BY instrumentid, date DESC
      ),
      pos AS (
        SELECT 
          o.instrumentid,
          sum(CASE o.side WHEN 'BUY' THEN o.size ELSE -o.size END) as quantity,
          sum(CASE WHEN o.side = 'BUY' THEN o.size * o.price ELSE 0 END) /
          nullif(sum(CASE WHEN o.side = 'BUY' THEN o.size ELSE 0 END), 0) as avg_price
        FROM orders o
        WHERE o.userid = :userId
          AND o.status = 'FILLED'
          AND o.side IN ('BUY', 'SELL')
        GROUP BY o.instrumentid
      )
      SELECT 
        p.instrumentid,
        i.ticker,
        i.name,
        i.type,
        p.quantity,
        p.avg_price::numeric(14,2) as avg_price,
        lp.close as market_price,
        lp.date as market_price_date,
        (p.quantity * coalesce(lp.close, p.avg_price))::numeric(14,2) as market_value,
        ((coalesce(lp.close, p.avg_price) - p.avg_price) * p.quantity)::numeric(14,2) as unrealized_pnl
      FROM pos p
      JOIN instruments i ON i.id = p.instrumentid
      LEFT JOIN last_price lp ON lp.instrumentid = p.instrumentid
      WHERE i.type <> 'MONEDA'
        AND p.quantity <> 0
      ORDER BY market_value DESC NULLS LAST
    `;

    const result = await this.prisma.$queryRawUnsafe(positionsQuery, { userId });
    return result as PortfolioPosition[];
  }
}