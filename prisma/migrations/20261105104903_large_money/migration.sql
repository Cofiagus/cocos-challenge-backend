-- Migración: ampliar capacidad monetaria a NUMERIC(24,2) y acotar los valores
-- financieros con CHECKs.
--
-- Generada con `npx prisma migrate dev --create-only --name large_money` y
-- personalizada SÓLO agregando los CHECKs, bajo la excepción acotada D5 de
-- specs/datos-financieros-grandes-montos.md (§2, §6) registrada en AGENTS.md.
-- No se edita la migración inicial 20261103003419_init_trading_api.
--
-- Unidades: orders.price/filledPrice = ARS por acción; marketdata.high/low/open/
-- close/previousclose = ARS por acción; orders.size = acciones (BUY/SELL) o
-- monto cash en ARS (CASH_IN/CASH_OUT). Máximo por valor almacenado:
-- 9999999999999999999999.99 (D1). IDs, FKs, índices y nullabilidad no cambian.
--
-- Límite conocido: el typmod NUMERIC(24,2) redondea una entrada con más de dos
-- decimales ANTES de evaluar el CHECK (p. ej. 1.005 -> 1.01), y rechaza
-- 'Infinity'/'-Infinity' por overflow. Los CHECKs garantizan el valor
-- almacenado (incluido NaN, que en PostgreSQL ordena por encima de todo), no
-- reconstruyen la precisión de una escritura SQL externa; el contrato HTTP
-- rechaza la escala mayor antes de persistir.

-- AlterTable
ALTER TABLE "marketdata" ALTER COLUMN "high" SET DATA TYPE DECIMAL(24,2),
ALTER COLUMN "low" SET DATA TYPE DECIMAL(24,2),
ALTER COLUMN "open" SET DATA TYPE DECIMAL(24,2),
ALTER COLUMN "close" SET DATA TYPE DECIMAL(24,2),
ALTER COLUMN "previousclose" SET DATA TYPE DECIMAL(24,2);

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "size" SET DATA TYPE DECIMAL(24,2),
ALTER COLUMN "price" SET DATA TYPE DECIMAL(24,2),
ALTER COLUMN "filledPrice" SET DATA TYPE DECIMAL(24,2);

-- CHECKs financieros (D5): sólo columnas modificadas y sólo valores no nulos.
-- Un NULL ya permitido por el snapshot sigue siendo válido; no se endurece la
-- nullabilidad legacy ni se tocan estados, tickers, emails ni idempotencia.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_price_finite_positive_check" CHECK (
    "price" IS NULL OR ("price" <> 'NaN'::numeric AND "price" > 0)
  ),
  ADD CONSTRAINT "orders_filledprice_finite_positive_check" CHECK (
    "filledPrice" IS NULL OR ("filledPrice" <> 'NaN'::numeric AND "filledPrice" > 0)
  ),
  -- size: finito y no negativo en cualquier side; cero sólo en REJECTED
  -- (histórico ZERO_SIZE), nunca en una fila operable.
  ADD CONSTRAINT "orders_size_finite_non_negative_check" CHECK (
    "size" IS NULL OR ("size" <> 'NaN'::numeric AND "size" >= 0)
  ),
  ADD CONSTRAINT "orders_size_zero_only_rejected_check" CHECK (
    "size" IS NULL OR "size" > 0 OR "status" = 'REJECTED'
  ),
  -- acciones por orden: entero y acotado a INT4 (D2); cash no pasa por acá.
  ADD CONSTRAINT "orders_share_size_int4_check" CHECK (
    "size" IS NULL
      OR "side" IS NULL
      OR "side" NOT IN ('BUY', 'SELL')
      OR ("size" = trunc("size") AND "size" <= 2147483647)
  );

ALTER TABLE "marketdata"
  ADD CONSTRAINT "marketdata_prices_finite_non_negative_check" CHECK (
    ("high" IS NULL OR ("high" <> 'NaN'::numeric AND "high" >= 0))
    AND ("low" IS NULL OR ("low" <> 'NaN'::numeric AND "low" >= 0))
    AND ("open" IS NULL OR ("open" <> 'NaN'::numeric AND "open" >= 0))
    AND ("close" IS NULL OR ("close" <> 'NaN'::numeric AND "close" >= 0))
    AND ("previousclose" IS NULL OR ("previousclose" <> 'NaN'::numeric AND "previousclose" >= 0))
  );
