// Huella canónica del REQUEST de orden (UC-3) — F2-IDEM, decisión Q1=A.
//
// Por qué vive en `contracts/`: la calcula el borde HTTP (con el body YA
// validado) y la consume la aplicación al armar el draft, así que ninguna de
// esas dos capas puede ser su dueña sin crear una dependencia prohibida
// (`application → http`). Es una derivación PURA del contrato de cable: sin
// DB, sin reloj, sin Express.
//
// Qué resuelve: el `amountArs` original se pierde en `resolveSizing`
// (`floor(amount/precio)`), y comparar el `size` derivado hacía que dos
// pedidos DISTINTOS (1000.00 vs 1000.50) cayeran en el mismo floor y se
// trataran como REPLAY en vez del 409 que prometen README y DECISIONS.md.

import { createHash } from "node:crypto";

import { serializeMoneyArs } from "./money.js";
import type { CreateOrderRequest } from "./orders.js";

/**
 * Versión del formato canónico. Cambiarla invalida las huellas persistidas: una
 * fila con otra versión NO se compara (el claim cae a la comparación
 * histórica), así que sólo se sube al cambiar el payload canónico.
 */
const FINGERPRINT_VERSION = "fp1";

/** Largo del sha256 hex truncado: 128 bits, corto y sin colisión práctica. */
const FINGERPRINT_HASH_LENGTH = 32;

/** Dinero canónico del request: string de 2 decimales ("123.0" ≡ "123.00"). */
const canonicalMoney = (
  value: CreateOrderRequest["price"] | CreateOrderRequest["amountArs"],
): string =>
  value === null || value === undefined ? "null" : serializeMoneyArs(value);

/**
 * Huella del request ORIGINAL, calculada ANTES de cualquier derivación.
 *
 * Campos, siempre en este orden: versión · `instrumentId` RESUELTO (nunca el
 * ticker: `ticker` e `instrumentId` del mismo papel dan la MISMA huella) ·
 * side · type · timeInForce · price canónico a 2 decimales · `amountArs`
 * canónico · `size` explícito.
 *
 * El monto ORIGINAL viaja en la huella, no el `size` derivado: 1000.00 y
 * 1000.50 caen en el mismo floor y AUN ASÍ son pedidos distintos. La huella no
 * es secreta ni PII — es un resumen del payload.
 */
export const requestFingerprintOf = (
  request: CreateOrderRequest,
  instrumentId: number,
): string => {
  const canonical = [
    FINGERPRINT_VERSION,
    `instrumentId=${String(instrumentId)}`,
    `side=${request.side}`,
    `type=${request.type}`,
    `timeInForce=${request.timeInForce}`,
    `price=${canonicalMoney(request.price)}`,
    `amountArs=${canonicalMoney(request.amountArs)}`,
    `size=${request.size === undefined ? "null" : String(request.size)}`,
  ].join("|");
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, FINGERPRINT_HASH_LENGTH);
  return `${FINGERPRINT_VERSION}:${digest}`;
};
