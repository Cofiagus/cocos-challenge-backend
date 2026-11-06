// Error ÚNICO de la capa de aplicación: status HTTP + código estable del
// contrato + mensaje. Los errores de cada caso de uso (envío, cancelación,
// transferencia) lo extienden sin redefinir constructor ni campos, así sus
// nombres exportados y su firma `(status, code, message)` siguen intactos
// para `toHttpError` y para los routers.
//
// Vive fuera de los slices porque NO es de un caso de uso: es el contrato de
// error que comparten todos. La traducción a respuesta HTTP sigue en el borde.

import type { ApiErrorCode } from "../contracts/index.js";

export class ApplicationError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    // `new.target.name` conserva el nombre de la subclase concreta (logs y
    // `error.name`) sin que cada subclase declare un constructor propio.
    this.name = new.target.name;
  }
}
