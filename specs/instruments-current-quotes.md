# Spec — búsqueda de instrumentos con cotizaciones actuales

> Rev. 2 — validada por el usuario; exige un error explícito si Yahoo no está disponible.
> Historial: Rev. 1 propuso el alcance; Rev. 2 confirma las políticas de faltantes
> e indisponibilidad y fija el contrato de error por decisión del usuario.
> Decisión del usuario: query ausente o vacía devuelve 10 tickers por defecto;
> los resultados deben usar precio y variación actuales de Yahoo, no el seed.
> Cambio acotado a UC-2. No reabre el matching ni los demás casos de uso.

## Why

`GET /api/instruments` hoy exige query no vacía, limita a 20 por defecto y
presenta precios del dataset estático. No cumple la búsqueda solicitada:
listado inicial de 10 instrumentos y cotizaciones actuales del proveedor.

## What

- `GET /api/instruments`, `?query=` y query sólo con espacios: listado inicial.
- Con texto: conservar búsqueda parcial case-insensitive por ticker o nombre.
- Conservar exclusión de MONEDA y orden ascendente por ticker.
- Default de `limit`: 10; conservar el parámetro opcional entero 1..100.
- Consultar Yahoo para los instrumentos candidatos del catálogo, usando símbolo
  directo `ticker + ".BA"`, sin mapping de renombradas.
- `price`: último precio de sesión disponible informado por Yahoo.
- `previousClose`: cierre de la sesión anterior, no el cierre inicial de un
  rango arbitrario de histórico.
- `dailyVariationPct`: `(price - previousClose) / previousClose × 100`,
  calculado con Decimal y serializado a dos decimales.
- Conservar respuesta array y campos `ticker`, `name`, `type`, `price`,
  `previousClose`, `dailyVariationPct`; no agregar campos en esta tarea.
- «Actual» significa último dato disponible en Yahoo: no prometer precio
  instantáneo ni fabricar nuevas cotizaciones con el mercado cerrado.
- El filtro se aplica al catálogo antes de consultar cotizaciones. La política
  de instrumentos sin cotización decide si hace falta buscar más candidatos.

### Decisiones aprobadas

1. Ticker sin cotización válida o sin cierre anterior computable:
   **Omitirlo y completar el límite con los siguientes candidatos**,
   sin reemplazarlo por el precio del seed. Puede haber menos resultados si
   no existen suficientes instrumentos con cotización válida.
2. Yahoo indisponible, timeout o rate-limit:
   **HTTP 503 Service Unavailable**, sin devolver precios históricos como si
   fueran actuales ni un array vacío que disimule la falla. Formato uniforme:

   ```json
   {
     "error": {
       "code": "MARKET_DATA_SERVICE_UNAVAILABLE",
       "message": "El servicio de cotizaciones (Yahoo Finance) no está disponible. Intentá nuevamente más tarde."
     }
   }
   ```

   Una falla de disponibilidad no se trata como ticker sin cotización: no
   omitir instrumentos por ese motivo ni devolver un listado parcial como éxito.
3. El usuario valida el conjunto de cambios de esta spec. La autorización
   incluye los cambios acotados de contrato (query/limit/errores), pero no
   nuevas dependencias, migraciones ni cambios en otros UC.

## Constraints

- No modificar precios de portfolio ni ejecución de órdenes en esta tarea.
- Sin ingesta periódica, cron, matching, price_ticks, migraciones ni tablas nuevas.
- Sin autenticación, paginación nueva, tabla de símbolos ni dependencias nuevas.
- Acceso a Yahoo detrás de un puerto inyectable; no hacer fetch desde el router
  ni introducir detalles HTTP del proveedor en dominio/aplicación.
- Timeout y concurrencia acotados; no consultar todo el catálogo si no hace falta.
- Validar respuesta externa con Zod; moneda ARS y números finitos. Dinero a
  Decimal desde strings; sin cálculos financieros en number y sin any.
- Tests deterministas sin Internet, con fuente inyectada. Verificación manual
  real separada para el adaptador; no inventar fixtures como prueba de conexión.
- Preservar todos los cambios locales ajenos a esta spec.

## Tasks

Cada tarea de implementación toca 1–2 archivos. Toda tarea con cambio en archivos
públicos tiene su tarea documental inmediatamente asociada antes de cerrar el lote.

1. **Contrato de búsqueda:** `src/contracts/instruments.ts` y un test unitario
   dedicado. Verificar query ausente/vacía/espacios/texto, default 10 y límites.
2. **Puerto de cotización:** `src/domain/ports/index.ts` y su entrada en
   `docs/CODEMAP.md`. Verificar typecheck y dependencia libre de infraestructura.
3. **Adaptador Yahoo:** nuevo adaptador y su test unitario. Verificar precio,
   cierre anterior de sesión, moneda, datos incompletos, timeout y rate-limit.
4. **Caso de uso de búsqueda:** nuevo caso de uso y su test unitario. Verificar
   filtro, orden, límite, política aprobada de faltantes y ausencia de seed fallback.
5. **Cableado HTTP:** `src/http/instruments/instruments-router.ts` y
   `src/http/server.ts`. Verificar que el router sólo valide y serialice.
6. **Funcionales de lectura:** `tests/functional/read/support.ts` y
   `tests/functional/read/read-endpoints.test.ts`. Inyectar cotizaciones
   controladas para UC-2 sin alterar lo probado de portfolio; verificar contrato.
7. **OpenAPI:** `scripts/openapi/wire.ts` y `scripts/openapi/registry.ts`, si sus
   espejos/metadatos lo requieren. Verificar equivalencia con Zod.
8. **Contrato generado y semántica:** `openapi.json` y `docs/api.md`. Regenerar
   OpenAPI; documentar query vacía, default 10 y política de fallos aprobada.
9. **Mapa y decisiones vigentes:** `docs/CODEMAP.md` y `DECISIONS.md`. Registrar
   la reapertura exclusiva de Yahoo para UC-2; no reabrir el resto del alcance.
10. **Entrada de documentación:** `README.md` y `docs/legacy.md`. Quitar la
    afirmación global de que Yahoo no está integrado y conservar límites históricos.
11. **Sincronización del dominio:** `specs/trading-api-domain.md` y
    `docs/arquitectura-implementada.html`. Reflejar sólo UC-2, con revisión y
    decisión humana; mantener el resto del matching fuera de alcance.
12. **Gate completo:** typecheck + lint + tests + build con output real;
    consulta real a Yahoo y smoke del endpoint. Informar limitaciones observadas.

## Evidencia inicial (no es verificación de cobertura del catálogo)

Sonda directa realizada el 4 de noviembre de 2026 al chart de `PAMP.BA`,
`range=1d&interval=1m`: HTTP 200; respuesta con `currency=ARS`,
`regularMarketPrice`, `regularMarketTime` y `previousClose`.
Una respuesta correcta no demuestra disponibilidad de todos los tickers ni SLA.
