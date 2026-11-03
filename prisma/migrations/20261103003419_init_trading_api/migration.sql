-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL', 'CASH_IN', 'CASH_OUT');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC', 'FOK');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('ACCEPTED', 'REJECTED', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderEventReason" AS ENUM ('INSUFFICIENT_FUNDS', 'INSUFFICIENT_POSITION', 'ZERO_SIZE', 'NO_PRICE', 'NO_IMMEDIATE_MATCH');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255),
    "accountnumber" VARCHAR(20),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "id" SERIAL NOT NULL,
    "ticker" VARCHAR(10),
    "name" VARCHAR(255),
    "type" VARCHAR(10),

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata" (
    "id" SERIAL NOT NULL,
    "instrumentid" INTEGER,
    "high" DECIMAL(10,2),
    "low" DECIMAL(10,2),
    "open" DECIMAL(10,2),
    "close" DECIMAL(10,2),
    "previousclose" DECIMAL(10,2),
    "date" DATE,

    CONSTRAINT "marketdata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "instrumentid" INTEGER,
    "userid" INTEGER,
    "size" INTEGER,
    "price" DECIMAL(10,2),
    "type" "OrderType",
    "side" "OrderSide",
    "status" "OrderStatus",
    "datetime" TIMESTAMP(6),
    "timeInForce" "TimeInForce" NOT NULL DEFAULT 'GTC',
    "filledPrice" DECIMAL(10,2),
    "filledAt" TIMESTAMP(6),
    "idempotencyKey" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" SERIAL NOT NULL,
    "orderid" INTEGER NOT NULL,
    "eventType" "OrderEventType" NOT NULL,
    "reason" "OrderEventReason",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketdata_instrumentid_date_idx" ON "marketdata"("instrumentid", "date" DESC);

-- CreateIndex
CREATE INDEX "orders_status_instrumentid_idx" ON "orders"("status", "instrumentid");

-- CreateIndex
CREATE INDEX "orders_userid_status_idx" ON "orders"("userid", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_userid_idempotencyKey_key" ON "orders"("userid", "idempotencyKey");

-- CreateIndex
CREATE INDEX "order_events_orderid_idx" ON "order_events"("orderid");

-- AddForeignKey
ALTER TABLE "marketdata" ADD CONSTRAINT "marketdata_instrumentid_fkey" FOREIGN KEY ("instrumentid") REFERENCES "instruments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_instrumentid_fkey" FOREIGN KEY ("instrumentid") REFERENCES "instruments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userid_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_orderid_fkey" FOREIGN KEY ("orderid") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
