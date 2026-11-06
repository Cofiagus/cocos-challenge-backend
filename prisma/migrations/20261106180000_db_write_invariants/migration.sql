-- Migración: invariantes de ESCRITURA de `orders` que hasta acá sólo
-- garantizaba la aplicación (Wave 4, célula F11-INVARIANTS / T11.c).
--
-- Create-only: NO se aplicó con `migrate dev` sobre ninguna base. El archivo
-- es DDL escrito a mano porque Prisma NO modela CHECK constraints ni triggers
-- en schema.prisma: `prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma` sobre el head no tiene drift (verificado en el ensayo).
--
-- Preflight medido (seed 11 órdenes · DB de la app 12 órdenes): LIMIT sin
-- price = 0; CASH_IN/CASH_OUT con price <> 1.00 = 0; CASH_IN/CASH_OUT con
-- instrumento <> ARS = 0; FILLED sin NINGÚN precio = 0; los 7 FILLED
-- heredados sí tienen `price` y `filledPrice` NULL.
--
-- 1) BACKFILL (idempotente): en el dataset legacy `price` YA es el precio de
--    ejecución (ver prisma/schema.prisma: filledPrice nace con esta wave).
--    Copiarlo a `filledPrice` habilita la forma estricta del CHECK #4 sin
--    inventar datos: no se toca ninguna otra columna. Correrlo dos veces es
--    un no-op (la condición `"filledPrice" IS NULL` deja de matchear).
--
--    Por qué además hay un TRIGGER de normalización: `db/seed.sql` es un
--    archivo GENERADO que no se edita y que se carga DESPUÉS de las
--    migraciones (scripts/test-db-reset.sh y el ensayo T11.d). Su COPY de
--    `orders` no incluye `filledPrice`, así que las 7 FILLED del seed entran
--    con NULL y el CHECK #4 las rechazaría en la carga. El trigger aplica
--    EXACTAMENTE la misma regla del backfill a toda fila que entre o cambie
--    por cualquier camino (COPY, INSERT, UPDATE). No agrega dependencias
--    externas: sólo `price` de la MISMA fila (la prohibición de trigger de la
--    spec §3.5 es para CASH ⇒ instrumento = ARS, que sí leería `instruments`).
--    Efecto: ninguna fila puede quedar FILLED sin filledPrice; si tampoco hay
--    `price`, el CHECK falla ruidosamente (23514) en vez de inventar un valor.
--
-- 2) CHECK LIMIT ⇒ price NOT NULL. 3) CHECK CASH ⇒ price = 1.00 (precio
--    unitario histórico del movimiento en ARS). 4) CHECK FILLED ⇒ filledPrice
--    NOT NULL (posible SÓLO después del backfill).
--
-- Fuera: `CASH ⇒ instrumento = ARS` NO es expresable como CHECK (PostgreSQL
-- prohíbe subqueries) y la spec §3.5 descarta el trigger que lo resolvería:
-- queda como invariante de aplicación (documentada en docs/CODEMAP.md).
--
-- Todas las constraints nacen VALIDADAS (convalidated = true): el backfill
-- previo garantiza que el dataset existente las cumple.

-- 1) Backfill de las FILLED heredadas (7 en el seed / 7 en la DB de la app).
UPDATE "orders"
SET "filledPrice" = "price"
WHERE "status" = 'FILLED' AND "filledPrice" IS NULL;

-- Normalización en escritura: misma regla que el backfill (ver cabecera).
CREATE OR REPLACE FUNCTION "orders_fill_execution_price"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'FILLED'
     AND NEW."filledPrice" IS NULL
     AND NEW."price" IS NOT NULL THEN
    NEW."filledPrice" := NEW."price";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_fill_execution_price_trigger"
BEFORE INSERT OR UPDATE OF "status", "price", "filledPrice" ON "orders"
FOR EACH ROW
EXECUTE FUNCTION "orders_fill_execution_price"();

-- 2-4) CHECKs de escritura.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_limit_requires_price_check" CHECK (
    "type" <> 'LIMIT'::"OrderType" OR "price" IS NOT NULL
  ),
  ADD CONSTRAINT "orders_cash_price_unit_check" CHECK (
    "side" NOT IN ('CASH_IN'::"OrderSide", 'CASH_OUT'::"OrderSide")
      OR "price" = 1.00
  ),
  ADD CONSTRAINT "orders_filled_requires_filledprice_check" CHECK (
    "status" <> 'FILLED'::"OrderStatus" OR "filledPrice" IS NOT NULL
  );
