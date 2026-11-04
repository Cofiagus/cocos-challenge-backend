// Borde HTTP compartido por los routers: funciones puras (sin Express) que
// traducen errores de validación a texto de respuesta. El texto viaja en el
// body de los 400: cambiarlo cambia la respuesta de la API.

import { z } from "zod";

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
export const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");
