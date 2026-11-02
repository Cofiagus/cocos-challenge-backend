-- ============================================================================
-- db/schema.sql  —  DDL de la base (generado por scripts/db-snapshot.py)
-- NO editar a mano: regenerar con `make db-snapshot`.
-- Cargar:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS public;

CREATE SEQUENCE IF NOT EXISTS public.instruments_id_seq AS integer;
CREATE SEQUENCE IF NOT EXISTS public.marketdata_id_seq AS integer;
CREATE SEQUENCE IF NOT EXISTS public.orders_id_seq AS integer;
CREATE SEQUENCE IF NOT EXISTS public.users_id_seq AS integer;

CREATE TABLE IF NOT EXISTS public.users (
    "id" integer DEFAULT nextval('users_id_seq'::regclass) NOT NULL,
    "email" character varying(255),
    "accountnumber" character varying(20),
    CONSTRAINT "users_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.instruments (
    "id" integer DEFAULT nextval('instruments_id_seq'::regclass) NOT NULL,
    "ticker" character varying(10),
    "name" character varying(255),
    "type" character varying(10),
    CONSTRAINT "instruments_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.orders (
    "id" integer DEFAULT nextval('orders_id_seq'::regclass) NOT NULL,
    "instrumentid" integer,
    "userid" integer,
    "size" integer,
    "price" numeric(10,2),
    "type" character varying(10),
    "side" character varying(10),
    "status" character varying(20),
    "datetime" timestamp without time zone,
    CONSTRAINT "orders_pkey" PRIMARY KEY (id),
    CONSTRAINT "orders_instrumentid_fkey" FOREIGN KEY (instrumentid) REFERENCES instruments(id),
    CONSTRAINT "orders_userid_fkey" FOREIGN KEY (userid) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS public.marketdata (
    "id" integer DEFAULT nextval('marketdata_id_seq'::regclass) NOT NULL,
    "instrumentid" integer,
    "high" numeric(10,2),
    "low" numeric(10,2),
    "open" numeric(10,2),
    "close" numeric(10,2),
    "previousclose" numeric(10,2),
    "date" date,
    CONSTRAINT "marketdata_pkey" PRIMARY KEY (id),
    CONSTRAINT "marketdata_instrumentid_fkey" FOREIGN KEY (instrumentid) REFERENCES instruments(id)
);
