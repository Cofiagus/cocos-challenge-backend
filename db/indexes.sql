-- ============================================================================
-- db/indexes.sql — Índices y constraints que la base NO tiene hoy.
--
-- NO los apliques sobre Neon: el challenge se resuelve contra el esquema real.
-- Usalos en la base LOCAL para medir impacto o para justificar la decisión en el README.
--
--   psql "$DATABASE_URL" -f db/indexes.sql
-- ============================================================================

-- Lookup del portfolio y del historial: user 1 -> sus órdenes por fecha
CREATE INDEX IF NOT EXISTS orders_userid_datetime_idx
  ON orders (userid, datetime DESC);

-- Órdenes abiertas (cancelación, matching de límites)
CREATE INDEX IF NOT EXISTS orders_new_idx
  ON orders (status) WHERE status = 'NEW';

-- Posiciones por instrumento
CREATE INDEX IF NOT EXISTS orders_instrumentid_idx
  ON orders (instrumentid);

-- "Último precio": la query más caliente del portfolio
CREATE INDEX IF NOT EXISTS marketdata_instrumentid_date_idx
  ON marketdata (instrumentid, date DESC);

-- Unicidad de las velas (no aplica si el seed tiene duplicados)
CREATE UNIQUE INDEX IF NOT EXISTS marketdata_instrumentid_date_key
  ON marketdata (instrumentid, date);

-- Búsqueda de instrumentos por ticker
CREATE UNIQUE INDEX IF NOT EXISTS instruments_ticker_key
  ON instruments (upper(ticker));

-- Alta / login
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key
  ON users (lower(email));

-- Validaciones que hoy no existen (varchar libre)
ALTER TABLE orders
  ADD CONSTRAINT orders_size_positive CHECK (size > 0),
  ADD CONSTRAINT orders_side_valid CHECK (side IN ('BUY','SELL','CASH_IN','CASH_OUT')),
  ADD CONSTRAINT orders_type_valid CHECK (type IN ('MARKET','LIMIT')),
  ADD CONSTRAINT orders_status_valid CHECK (status IN ('NEW','FILLED','CANCELLED','REJECTED'));

ALTER TABLE orders
  ALTER COLUMN status SET DEFAULT 'NEW',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN datetime SET DEFAULT now();
