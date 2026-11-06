-- Migración: invariantes de integridad que hoy sólo garantiza la aplicación.
--
-- Célula F3-DB (Wave 3, Q1=A / Q4=A). Create-only: NO se aplicó con
-- `migrate dev` sobre ninguna base; el DDL se generó con
--   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
-- contra la base de ensayo `cocos_f3_rehearsal` y se personalizó SÓLO
-- agregando los CHECKs de coherencia (mismo criterio que la migración
-- 20261105104903_large_money: no se edita ninguna migración ya aplicada).
--
-- Preflight medido sobre el seed cargado en el head vigente (11 orders, 126
-- marketdata):
--   NULL orders.instrumentid/userid/size/price/type/side/status/datetime ... 0
--   FILLED sin filledPrice .................................................. 7  (heredadas)
--   LIMIT sin price ......................................................... 0
--   CASH_IN/CASH_OUT con price <> 1.00 o instrumento <> ARS(66) ............. 0
--   velas duplicadas por (instrumentid, date) ............................... 0
--   marketdata.close / previousclose NULL ................................... 0
--   marketdata.high / low / open NULL ....................................... 2
--
-- Qué entra y qué no (y por qué):
--   * NOT NULL en orders.type/side/datetime y marketdata.instrumentid/date/
--     close/previousclose: el dominio los exige y el preflight los deja en 0
--     NULLs. marketdata.high/low/open y orders.instrumentid/userid/size/price
--     siguen nullable: el seed tiene 2 velas sin high/low/open, el contrato
--     OrderRecordCommon modela instrumentId/userId/size/price nullables para
--     filas legacy, una MARKET FILLED legítima guarda price NULL y una suite de
--     integración vigente inserta size NULL para probar CorruptRowError.
--   * orders.status sigue nullable: cash-idempotency.ts compara `status === null`
--     sobre la fila Prisma; endurecerlo exigiría tocar src/** (fuera de esta
--     célula).
--   * CHECK FILLED ⇒ filledPrice NOT NULL: **BLOCKER**, no entra. Las 7 FILLED
--     del seed tienen filledPrice NULL porque en el dataset legacy `price` YA es
--     el precio de ejecución (comentario de prisma/schema.prisma). Lo que sí
--     entra es la invariante que el seed cumple: FILLED ⇒ filledPrice OR price
--     NOT NULL (0 FILLED sin ningún precio). Endurecerla a filledPrice-only
--     exige backfill `filledPrice = price` en las 7 filas (decisión humana: los
--     históricos no se reescriben en esta célula, T3.c exige conservación).
--   * CHECK LIMIT ⇒ price NOT NULL: **BLOCKER**, no entra. El preflight lo deja
--     en 0 violaciones, pero el repositorio persiste filas LIMIT con price NULL
--     como caso de caracterización y tres tests vigentes
--     (order-repository.create-order.test.ts: "price NULL en la fila…",
--     "price no-NULL en la fila…", "price NULL en ambos lados…") dependen de
--     poder insertarlas; el CHECK los rompe. Queda garantizado por la app.
--   * CHECK CASH_IN/CASH_OUT ⇒ price = 1.00: **BLOCKER**, no entra. Preflight 0,
--     pero order-repository.idempotency.test.ts ("cambio de precio en una key
--     histórica") envía un draft cash con price 2.00 esperando CONFLICT; con el
--     CHECK el INSERT falla antes con 23514.
--   * CHECK CASH ⇒ instrumento = ARS(66): **BLOCKER**, no entra. Preflight 0,
--     pero el mismo it.each ("cambio de instrumento…") persiste una fila cash
--     con instrumentid de PAMP para caracterizar el CONFLICT.
--     Los tres requieren actualizar esos tests (fuera de las rutas de F3-DB) o
--     mover la regla a la capa de aplicación: decisión humana.
--   * UNIQUE(instrumentid, date) en marketdata: sin duplicados en el seed.
--   * orders.requestFingerprint: huella del payload canónico para COMPARAR
--     (Q1=A, la consume F2-IDEM). Nullable y SIN UNIQUE: dos órdenes legítimas
--     del mismo usuario con el mismo payload deben poder coexistir; la unicidad
--     ya la da (userid, "idempotencyKey").

-- AlterTable
ALTER TABLE "marketdata" ALTER COLUMN "instrumentid" SET NOT NULL,
ALTER COLUMN "close" SET NOT NULL,
ALTER COLUMN "previousclose" SET NOT NULL,
ALTER COLUMN "date" SET NOT NULL;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "requestFingerprint" TEXT,
ALTER COLUMN "type" SET NOT NULL,
ALTER COLUMN "side" SET NOT NULL,
ALTER COLUMN "datetime" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "marketdata_instrumentid_date_key" ON "marketdata"("instrumentid", "date");

-- CHECKs de coherencia estado/unidad (ver cabecera para el alcance).
ALTER TABLE "orders"
  -- FILLED exige UN precio de ejecución. La forma estricta
  -- (`filledPrice IS NOT NULL`) es BLOCKER: 7 filas FILLED del seed tienen
  -- filledPrice NULL porque en el dataset legacy `price` YA es la ejecución.
  -- Esta es la invariante que el seed sí cumple (0 FILLED sin price): ninguna
  -- FILLED puede quedar sin NINGÚN precio.
  ADD CONSTRAINT "orders_filled_requires_execution_price_check" CHECK (
    NOT ("status" IS NOT DISTINCT FROM 'FILLED'::"OrderStatus")
      OR "filledPrice" IS NOT NULL
      OR "price" IS NOT NULL
  );
