// Error de fila corrupta.
//
// El contrato (src/contracts/domain.ts) da por NO-NULOS varios campos que
// el schema del snapshot permite en NULL (columnas legacy del COPY). Si una
// fila viene con NULL donde el contrato exige valor, es corrupción de
// datos: el mapper falla RUIDOSAMENTE (nunca normaliza en silencio).

/** Fila con un campo NULL/inesperado que el contrato da por no-nulo. */
export class CorruptRowError extends Error {
  constructor(row: string, field: string) {
    super(
      `Fila corrupta: ${row}.${field} vino NULL pero el contrato lo da por ` +
        `no-nulo. No se normaliza en silencio — revisar los datos.`,
    );
    this.name = "CorruptRowError";
  }
}