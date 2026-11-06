# Spec — búsqueda de instrumentos con cotizaciones actuales

> **Estado: implementada.**
> Reglas: query ausente o vacía devuelve 10 tickers por defecto; los resultados usan precio y
> variación actuales de Yahoo, no el seed; si Yahoo no está disponible se responde un error
> explícito (503). Cambio acotado a UC-2: el matching y los demás casos de uso no se modifican.

## Motivo

`GET /api/instruments` exigía query no vacía, limitaba a 20 por defecto y
presentaba precios del dataset estático. La búsqueda del producto es otra:
listado inicial de 10 instrumentos y cotizaciones actuales del proveedor.

## Alcance

- `GET /api/instruments`, `?query=` y query sólo con espacios: listado inicial.
- Con texto: búsqueda parcial case-insensitive por ticker o nombre.
- Exclusión de MONEDA y orden ascendente por ticker.
- Default de `limit`: 10; el parámetro opcional entero 1..100 se conserva.
- Consulta a Yahoo para los instrumentos candidatos del catálogo, con símbolo
  directo `ticker + ".BA"` y sin mapping de renombradas.
- `price`: último precio de sesión disponible informado por Yahoo.
- `previousClose`: cierre de la sesión anterior, no el cierre inicial de un
  rango arbitrario de histórico.
- `dailyVariationPct`: `(price - previousClose) / previousClose × 100`,
  calculado con Decimal y serializado a dos decimales.
- Respuesta array con los campos `ticker`, `name`, `type`, `price`,
  `previousClose`, `dailyVariationPct`; sin campos adicionales.
- «Actual» es el último dato disponible en Yahoo: la API no promete precio
  instantáneo ni fabrica cotizaciones nuevas con el mercado cerrado.
- El filtro se aplica al catálogo antes de consultar cotizaciones. La política
  de instrumentos sin cotización decide cuándo se buscan más candidatos.

### Decisiones de diseño

1. Ticker sin cotización válida o sin cierre anterior computable:
   **se omite y el límite se completa con los siguientes candidatos**,
   sin reemplazarlo por el precio del seed. Un listado puede devolver menos
   resultados si no existen suficientes instrumentos con cotización válida.
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

   Una falla de disponibilidad no es un ticker sin cotización: el listado no se
   recorta por ese motivo ni devuelve un resultado parcial como éxito.
3. El alcance son los cambios acotados de contrato (query/limit/errores), sin
   dependencias nuevas, sin migraciones y sin cambios en otros UC.

## Restricciones

- Los precios de portfolio y la ejecución de órdenes quedan fuera de este cambio.
- Sin ingesta periódica, cron, matching, price_ticks, migraciones ni tablas nuevas.
- Sin autenticación, paginación nueva, tabla de símbolos ni dependencias nuevas.
- El acceso a Yahoo vive detrás de un puerto inyectable: el router no hace fetch
  y el dominio/aplicación no ven detalles HTTP del proveedor.
- Timeout y concurrencia acotados; el catálogo no se consulta completo si no hace falta.
- La respuesta externa se valida con Zod; moneda ARS y números finitos. El dinero
  entra a Decimal desde strings, sin cálculos financieros en number y sin any.
- Los tests son deterministas y sin Internet, con fuente inyectada. La conexión con
  Yahoo se verifica contra la API viva, no con fixtures.

## Implementación por componente

1. **Contrato de búsqueda:** `src/contracts/instruments.ts` con query
   ausente/vacía/espacios/texto, default 10 y límites, cubierto por un test unitario dedicado.
2. **Puerto de cotización:** `src/domain/ports/index.ts` declara `InstrumentQuoteSource`
   y `docs/CODEMAP.md` lo registra; el puerto no depende de infraestructura.
3. **Adaptador Yahoo:** `src/infra/yahoo/yahoo-instrument-quote-source.ts` resuelve precio,
   cierre anterior de sesión, moneda, datos incompletos, timeout y rate-limit, con test unitario.
4. **Caso de uso de búsqueda:** `src/application/instruments/search-instruments.ts` aplica
   filtro, orden, límite, la política de faltantes y ningún fallback al seed; test unitario propio.
5. **Cableado HTTP:** `src/http/instruments/instruments-router.ts` y `src/http/server.ts`;
   el router valida y serializa, el caso de uso resuelve.
6. **Funcionales de lectura:** `tests/functional/read/support.ts` y
   `tests/functional/read/read-endpoints.test.ts` inyectan cotizaciones controladas para UC-2
   sin alterar lo probado de portfolio, y verifican el contrato.
7. **OpenAPI:** `scripts/openapi/wire.ts` y `scripts/openapi/registry.ts` espejan el schema
   y los metadatos, con equivalencia verificada contra Zod.
8. **Contrato generado y semántica:** `openapi.json` y `docs/api.md` documentan query vacía,
   default 10 y la política de fallos.
9. **Mapa y decisiones vigentes:** `docs/CODEMAP.md` y `DECISIONS.md` registran la
   habilitación de Yahoo para UC-2 y su alcance acotado.
10. **Entrada de documentación:** `README.md` documenta la integración con Yahoo para UC-2 y sus límites.
11. **Sincronización del dominio:** `specs/trading-api-domain.md` refleja UC-2 y mantiene el
    resto del matching fuera de alcance.
12. **Verificación:** typecheck, lint, tests y build con salida real, más consulta a Yahoo y
    smoke del endpoint.

## Evidencia de la fuente

Sonda directa del 4 de noviembre de 2026 al chart de `PAMP.BA`,
`range=1d&interval=1m`: HTTP 200 con `currency=ARS`, `regularMarketPrice`,
`regularMarketTime` y `previousClose`. La fuente entrega los cuatro campos que el
contrato consume, con precios en ARS.

La cobertura del catálogo es una medición distinta: **61 de 65** acciones responden
con el símbolo directo; `DYCA`, `PGR`, `IRCP` y `MTR` responden 404 y el contrato los
omite. La evidencia cubre esos dos hechos —campos de la respuesta y cobertura medida—;
no mide latencia ni disponibilidad sostenida del proveedor, que no tiene SLA.
