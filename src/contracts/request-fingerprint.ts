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
import type { FinancialDecimal } from "./financial-decimal.js";
import type { TransferSide } from "./enums.js";

/**
 * Versión del formato canónico. Cambiarla invalida las huellas persistidas: una
 * fila con otra versión NO se compara (el claim cae a la comparación
 * histórica), así que sólo se sube al cambiar el payload canónico.
 */
const FINGERPRINT_VERSION = "fp1";

/** Largo del sha256 hex truncado: 128 bits, corto y sin colisión práctica. */
const FINGERPRINT_HASH_LENGTH = 32;

/**
 * Versión del formato canónico de CASH. Es OTRA versión (no `fp1`) porque el
 * payload canónico es otro: así una huella de cash nunca puede compararse
 * contra una de trading, y subir el formato de uno no invalida el del otro.
 */
const CASH_FINGERPRINT_VERSION = "fpc1";

/** sha256 hex truncado, prefijado con la versión del formato. */
const fingerprintDigest = (
  version: string,
  fields: readonly string[],
): string => {
  const digest = createHash("sha256")
    .update([version, ...fields].join("|"))
    .digest("hex")
    .slice(0, FINGERPRINT_HASH_LENGTH);
  return `${version}:${digest}`;
};

/** Dinero canónico del request: string de 2 decimales ("123.0" ≡ "123.00"). */
const canonicalMoney = (
  value: FinancialDecimal | null | undefined,
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
): string =>
  fingerprintDigest(FINGERPRINT_VERSION, [
    `instrumentId=${String(instrumentId)}`,
    `side=${request.side}`,
    `type=${request.type}`,
    `timeInForce=${request.timeInForce}`,
    `price=${canonicalMoney(request.price)}`,
    `amountArs=${canonicalMoney(request.amountArs)}`,
    `size=${request.size === undefined ? "null" : String(request.size)}`,
  ]);

/**
 * Pedido de CASH (UC-5) del que se calcula la huella. Es el request TAL COMO
 * lo decide la aplicación: las transferencias no tienen body HTTP propio
 * (`side` + `amountArs`), y el instrumento/type/price los fija el caso de uso.
 */
export interface CashRequestFingerprintInput {
  readonly instrumentId: number;
  readonly side: TransferSide;
  readonly type: string;
  readonly timeInForce: string;
  /** Precio unitario histórico del cash (1.00); null no es válido, se conserva. */
  readonly priceArs: FinancialDecimal | null;
  /** Monto EXACTO en ARS (D4: sin floor) — el dato que el replay debe distinguir. */
  readonly amountArs: FinancialDecimal;
}

/**
 * Huella del pedido de CASH original (R-02).
 *
 * El monto exacto viaja ACÁ además de en `metadata.amountArs` del evento: la
 * evidencia del evento sigue mandando cuando la fila es histórica (sin huella),
 * pero un pedido nuevo con la MISMA key y otro monto se detecta por la huella
 * sin depender de que la auditoría siga siendo legible. Dos montos distintos
 * (1000.00 vs 1000.50) tienen huellas distintas aunque su `size` histórico
 * (floor) coincida.
 *
 * El dinero se normaliza a 2 decimales: "123.0" ≡ "123.00". No incluye userId
 * (la unicidad la da UNIQUE(userId, idempotencyKey)) ni el idempotencyKey.
 */
export const cashRequestFingerprintOf = (
  request: CashRequestFingerprintInput,
): string =>
  fingerprintDigest(CASH_FINGERPRINT_VERSION, [
    `instrumentId=${String(request.instrumentId)}`,
    `side=${request.side}`,
    `type=${request.type}`,
    `timeInForce=${request.timeInForce}`,
    `price=${canonicalMoney(request.priceArs)}`,
    `amountArs=${canonicalMoney(request.amountArs)}`,
  ]);
