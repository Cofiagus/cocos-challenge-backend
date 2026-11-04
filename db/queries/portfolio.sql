-- ============================================================================
-- db/queries/portfolio.sql — proyección de cash + posiciones desde orders.
--
-- Es la query que resuelve GET /api/users/portfolio. Verificada contra el seed:
--   user 1 -> cash 753000.00, PAMP 40, METR 500, BMA -10
--
-- Uso: pegar en psql y reemplazar :userid, o
--   psql "$DATABASE_URL" -v userid=1 -f db/queries/portfolio.sql
-- ============================================================================

\if :{?userid}
\else
  \set userid 1
\endif

-- ---------------------------------------------------------------------------
-- 1) CASH: sólo FILLED mueve saldo.
--    CASH_IN / SELL  suman ; CASH_OUT / BUY  restan.
-- ---------------------------------------------------------------------------
SELECT
  :userid AS userid,
  coalesce(sum(CASE side
                 WHEN 'CASH_IN'  THEN  size * price
                 WHEN 'SELL'     THEN  size * price
                 WHEN 'CASH_OUT' THEN -size * price
                 WHEN 'BUY'      THEN -size * price
               END), 0)::numeric(14,2) AS cash
FROM orders
WHERE userid = :userid
  AND status = 'FILLED';

-- ---------------------------------------------------------------------------
-- 2) CASH COMPROMETIDO (opcional): las LIMIT BUY en NEW reservan plata.
--    Es una decisión de diseño abierta — ver docs/database.md §7.1
-- ---------------------------------------------------------------------------
SELECT
  coalesce(sum(size * price), 0)::numeric(14,2) AS cash_reserved
FROM orders
WHERE userid = :userid
  AND status = 'NEW'
  AND side = 'BUY';

-- ---------------------------------------------------------------------------
-- 3) POSICIONES con precio de mercado y P&L.
--    Excluye ARS (MONEDA): es el cash, no una posición.
--    LEFT JOIN a la última vela: PGR, IRCP y ARS no tienen market data ->
--    marketprice viene NULL y hay que decidir el fallback en la app.
-- ---------------------------------------------------------------------------
WITH last_price AS (
  SELECT DISTINCT ON (m.instrumentid) m.instrumentid, m.date, m.close
  FROM   marketdata m
  ORDER  BY m.instrumentid, m.date DESC
),
pos AS (
  SELECT o.instrumentid,
         sum(CASE o.side WHEN 'BUY' THEN o.size ELSE -o.size END) AS quantity,
         sum(CASE WHEN o.side = 'BUY' THEN o.size * o.price ELSE 0 END)
           / nullif(sum(CASE WHEN o.side = 'BUY' THEN o.size ELSE 0 END), 0) AS avg_price
  FROM   orders o
  WHERE  o.userid = :userid
    AND  o.status = 'FILLED'
    AND  o.side IN ('BUY','SELL')
  GROUP  BY o.instrumentid
)
SELECT
  p.instrumentid,
  i.ticker,
  i.name,
  i.type,
  p.quantity,
  p.avg_price::numeric(14,2)                          AS avg_price,
  lp.close                                            AS market_price,
  lp.date                                             AS market_price_date,
  (p.quantity * coalesce(lp.close, p.avg_price))::numeric(14,2) AS market_value,
  ((lp.close - p.avg_price) * p.quantity)::numeric(14,2)        AS unrealized_pnl
FROM   pos p
JOIN   instruments i ON i.id = p.instrumentid
LEFT   JOIN last_price lp ON lp.instrumentid = p.instrumentid
WHERE  i.type <> 'MONEDA'
  AND  p.quantity <> 0
ORDER  BY market_value DESC NULLS LAST;
