// Borde HTTP — lectura del header Idempotency-Key (tests SIN DB).
//
// Caracteriza el comportamiento que hoy vive embebido en
// src/http/orders/orders-router.ts: el header es OPCIONAL, su valor viaja al
// caso de uso TAL CUAL (no se recortan espacios) y Express entrega un header
// repetido como array. La réplica de abajo es una copia fiel de esa lectura;
// el refactor la reemplaza por la función compartida de src/http/shared/edge.ts
// sin tocar ningún caso.

import type { IncomingHttpHeaders } from "node:http";
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
} from "../../../src/contracts/index.js";

type IdempotencyKeyHeader =
  | { readonly ok: true; readonly key: string | null }
  | { readonly ok: false };

/** Réplica fiel de la lectura actual del router de órdenes. */
const parseIdempotencyKeyHeader = (
  headers: IncomingHttpHeaders,
): IdempotencyKeyHeader => {
  const raw = headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return { ok: true, key: null };
  }
  const parsed = IdempotencyKeySchema.safeParse(value);
  return parsed.success ? { ok: true, key: parsed.data } : { ok: false };
};

describe("parseIdempotencyKeyHeader", () => {
  it("header ausente ⇒ key null (la key es opcional)", () => {
    expect(parseIdempotencyKeyHeader({})).toEqual({ ok: true, key: null });
  });

  it("header vacío ⇒ inválido (el contrato exige 1..64 caracteres)", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "" }),
    ).toEqual({ ok: false });
  });

  it("sólo espacios ⇒ válido y SIN recortar (no se normaliza el valor)", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "   " }),
    ).toEqual({ ok: true, key: "   " });
  });

  it("header repetido (array) ⇒ toma el primero", () => {
    expect(
      parseIdempotencyKeyHeader({
        [IDEMPOTENCY_KEY_HEADER]: ["primera", "segunda"],
      }),
    ).toEqual({ ok: true, key: "primera" });
  });

  it("array vacío ⇒ se comporta como header ausente", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: [] }),
    ).toEqual({ ok: true, key: null });
  });

  it("array cuyo primer valor es vacío ⇒ inválido", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: ["", "segunda"] }),
    ).toEqual({ ok: false });
  });

  it("key normal ⇒ se devuelve tal cual", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "orden-123" }),
    ).toEqual({ ok: true, key: "orden-123" });
  });

  it("64 caracteres ⇒ válida; 65 ⇒ inválida (cota del contrato)", () => {
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "a".repeat(64) }),
    ).toEqual({ ok: true, key: "a".repeat(64) });
    expect(
      parseIdempotencyKeyHeader({ [IDEMPOTENCY_KEY_HEADER]: "a".repeat(65) }),
    ).toEqual({ ok: false });
  });
});
