#!/usr/bin/env python3
"""
Snapshot de la base de datos (esquema + datos) a SQL plano.

Genera:
  db/schema.sql   -> DDL reconstruido desde el catálogo de Postgres (sin datos)
  db/seed.sql     -> COPY de las tablas (datos) + setval de secuencias

Uso:
  DATABASE_URL="postgresql://..." python3 scripts/db-snapshot.py
  DATABASE_URL="postgresql://..." python3 scripts/db-snapshot.py --schema-only

Requiere: pip install "psycopg[binary]"   (ver requirements-db.txt)
"""

import argparse
import os
import socket
import sys
import time
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent
DB_DIR = ROOT / "db"

SCHEMA = "public"
# Orden de dependencias para crear/volcar (padres antes que hijos)
TABLES_ORDER = ["users", "instruments", "orders", "marketdata"]


def connect(dsn: str, attempts: int = 4) -> psycopg.Connection:
    """Conecta forzando IPv4.

    Esta máquina resuelve el host de Neon a AAAA y no tiene ruta IPv6: el connect
    queda en SYN-SENT hasta el timeout (~90 s). Pasamos `hostaddr` con el A record
    para saltear la elección de familia, manteniendo `host` para el TLS (SNI).
    Neon además suspende compute: el primer connect puede tardar 20-60 s.
    """
    from urllib.parse import urlsplit, parse_qsl, urlencode, urlunsplit

    parts = urlsplit(dsn)
    host = parts.hostname
    hostaddr = None
    if host:
        try:
            infos = socket.getaddrinfo(host, parts.port or 5432, socket.AF_INET, socket.SOCK_STREAM)
            hostaddr = infos[0][4][0]
        except socket.gaierror as exc:
            print(f"  ! DNS sin A record para {host}: {exc}", file=sys.stderr)

    kwargs = {"connect_timeout": 25}
    if hostaddr:
        kwargs["hostaddr"] = hostaddr
        print(f"  · {host} → {hostaddr} (IPv4 forzado)")

    last = None
    for i in range(attempts):
        try:
            return psycopg.connect(dsn, **kwargs)
        except psycopg.OperationalError as exc:  # cold start / DNS intermitente
            last = exc
            print(f"  ! connect falló ({i + 1}/{attempts}): {str(exc).splitlines()[0]}", file=sys.stderr)
            time.sleep(min(2**i, 10))
    raise SystemExit(f"No se pudo conectar: {last}")


def q(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall() if cur.description else None


def ordered_tables(conn) -> list[str]:
    rows = q(
        conn,
        """SELECT table_name FROM information_schema.tables
           WHERE table_schema=%s AND table_type='BASE TABLE' ORDER BY table_name""",
        (SCHEMA,),
    )
    names = [r[0] for r in rows]
    known = [t for t in TABLES_ORDER if t in names]
    return known + [t for t in names if t not in known]


def ddl_columns(conn, table) -> list[str]:
    rows = q(
        conn,
        """
        SELECT a.attname,
               format_type(a.atttypid, a.atttypmod) AS coltype,
               a.attnotnull,
               pg_get_expr(d.adbin, d.adrelid) AS default_expr,
               a.attidentity,
               a.attgenerated
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname=%s AND c.relname=%s AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
        """,
        (SCHEMA, table),
    )
    lines = []
    for name, coltype, notnull, default, identity, generated in rows:
        line = f'    "{name}" {coltype}'
        if identity:
            line += " GENERATED ALWAYS AS IDENTITY"
        elif generated:
            line += f" GENERATED ALWAYS AS ({default}) STORED"
        elif default:
            line += f" DEFAULT {default}"
        if notnull:
            line += " NOT NULL"
        lines.append(line)
    return lines


def ddl_constraints(conn, table) -> list[str]:
    rows = q(
        conn,
        """SELECT conname, pg_get_constraintdef(oid)
           FROM pg_constraint
           WHERE conrelid = (%s || '.' || %s)::regclass
             AND contype IN ('p','u','f','c','x')
           ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, conname""",
        (SCHEMA, table),
    )
    out = []
    for name, definition in rows:
        clause = definition
        # Las FK se nombran igual; para PK/UNIQUE/CHECK conservamos el nombre original
        if definition.startswith("FOREIGN KEY"):
            out.append(f"    CONSTRAINT \"{name}\" {clause}")
        else:
            out.append(f"    CONSTRAINT \"{name}\" {clause}")
    return out


def ddl_indexes(conn, table) -> list[str]:
    """Índices que NO respaldan constraints (los de PK/UNIQUE ya salen en el ALTER TABLE)."""
    rows = q(
        conn,
        """SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname=%s AND tablename=%s
             AND indexname NOT IN (
               SELECT conname FROM pg_constraint
               WHERE conrelid=(%s||'.'||%s)::regclass AND contype IN ('p','u','x'))
           ORDER BY indexname""",
        (SCHEMA, table, SCHEMA, table),
    )
    return [d + ";" for _, d in rows]


def ddl_comments(conn, table) -> list[str]:
    rows = q(
        conn,
        """SELECT a.attname, col_description(a.attrelid, a.attnum)
           FROM pg_attribute a
           WHERE a.attrelid=(%s||'.'||%s)::regclass AND a.attnum>0 AND NOT a.attisdropped
             AND col_description(a.attrelid, a.attnum) IS NOT NULL""",
        (SCHEMA, table),
    )
    return [f"COMMENT ON COLUMN {SCHEMA}.{table}.\"{c}\" IS {sql_lit(d)};" for c, d in rows]


def sql_lit(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_schema(conn) -> str:
    tables = ordered_tables(conn)
    seqs = q(
        conn,
        """SELECT s.sequencename, s.data_type
           FROM pg_sequences s WHERE s.schemaname=%s ORDER BY 1""",
        (SCHEMA,),
    )
    header = [
        "-- ============================================================================",
        "-- db/schema.sql  —  DDL de la base (generado por scripts/db-snapshot.py)",
        "-- NO editar a mano: regenerar con `make db-snapshot`.",
        "-- Cargar:  psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f db/schema.sql",
        "-- ============================================================================",
        "",
        f"CREATE SCHEMA IF NOT EXISTS {SCHEMA};",
        "",
    ]
    out = header[:]
    for name, seqtype in seqs:
        out.append(f"CREATE SEQUENCE IF NOT EXISTS {SCHEMA}.{name} AS {seqtype};")
    out.append("")

    for table in tables:
        cols = ddl_columns(conn, table)
        cons = ddl_constraints(conn, table)
        body = ",\n".join(cols + cons)
        out.append(f"CREATE TABLE IF NOT EXISTS {SCHEMA}.{table} (\n{body}\n);")
        out.append("")
        for idx in ddl_indexes(conn, table):
            out.append(idx)
        for cmt in ddl_comments(conn, table):
            out.append(cmt)
        if ddl_indexes(conn, table) or ddl_comments(conn, table):
            out.append("")

    return "\n".join(out).rstrip() + "\n"


def build_seed(conn) -> str:
    tables = ordered_tables(conn)
    out = [
        "-- ============================================================================",
        "-- db/seed.sql  —  Datos de la base (generado por scripts/db-snapshot.py)",
        "-- NO editar a mano: regenerar con `make db-snapshot`.",
        "-- Cargar después de db/schema.sql.",
        "-- ============================================================================",
        "",
        "BEGIN;",
        "",
    ]
    for table in tables:
        cols = [r[0] for r in q(
            conn,
            """SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid=(%s||'.'||%s)::regclass AND a.attnum>0 AND NOT a.attisdropped
               ORDER BY a.attnum""",
            (SCHEMA, table),
        )]
        collist = ", ".join(f'"{c}"' for c in cols)
        out.append(f"TRUNCATE {SCHEMA}.{table} CASCADE;")
        out.append(f"COPY {SCHEMA}.{table} ({collist}) FROM STDIN WITH (FORMAT csv, NULL '\\N');")
        with conn.cursor() as cur:
            with cur.copy(
                f"COPY (SELECT {collist} FROM {SCHEMA}.{table}) TO STDOUT "
                "WITH (FORMAT csv, NULL '\\N')"
            ) as cp:
                buf: list[str] = []
                for chunk in cp:
                    if isinstance(chunk, memoryview):
                        chunk = chunk.tobytes()
                    if isinstance(chunk, bytes):
                        chunk = chunk.decode("utf-8")
                    buf.append(chunk)
        # El COPY ya viene con "\n" al final de cada fila: unir sin separador,
        # si no se cuelan líneas en blanco y el load falla con "missing data".
        out.append("".join(buf).rstrip("\n"))
        out.append("\\.")
        out.append("")

    # setval: sin esto el próximo INSERT choca con la PK
    for table in tables:
        row = q(
            conn,
            """SELECT pg_get_serial_sequence(%s || '.' || %s, 'id'),
                      coalesce(max(id), 0) FROM {}.{}""".format(SCHEMA, table),
            (SCHEMA, table),
        )
        if row and row[0][0]:
            seq, maxid = row[0]
            out.append(
                f"SELECT setval('{seq}', {maxid if maxid else 1}, {str(bool(maxid)).lower()});"
            )
    out += ["", "COMMIT;", ""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema-only", action="store_true", help="no volcar datos")
    ap.add_argument("--url", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()

    if not args.url:
        sys.exit("Falta DATABASE_URL (o pasá --url).")

    DB_DIR.mkdir(exist_ok=True)
    print("→ conectando…")
    conn = connect(args.url)
    try:
        print("→ generando db/schema.sql")
        (DB_DIR / "schema.sql").write_text(build_schema(conn), encoding="utf-8")
        if not args.schema_only:
            print("→ generando db/seed.sql")
            (DB_DIR / "seed.sql").write_text(build_seed(conn), encoding="utf-8")
    finally:
        conn.close()
    print("✓ listo")


if __name__ == "__main__":
    main()
