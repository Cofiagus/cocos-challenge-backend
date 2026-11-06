# Fuentes de datos de mercado argentino — análisis y verificación

> Fundamento de la fuente de precios del challenge. Verificado en vivo el 2026-10-30 con
> llamadas reales contra cada fuente y cobertura medida contra el universo del seed
> (`db/seed.sql`).

## 1. Universo necesario

- 66 filas en `instruments`: 65 `ACCIONES` (panel líder + general, tickers BYMA) + 1 `MONEDA` (`ARS / PESOS` — no busca cotización).
- Campos requeridos por el challenge: `close` + `previousClose`, en **ARS** (columna `marketdata.close` del schema).
- **No se necesita tiempo real**: UC-2 pide el último dato disponible y UC-1/3/4/5 leen `marketdata`.

**Sobre el seed:** el universo contiene instrumentos que ya no cotizan (ver §4). Los faltantes no
son huecos de la fuente: son instrumentos sin mercado en la DB de ejemplo, y el contrato los omite.

## 2. Fuentes evaluadas

### 2.1 Yahoo Finance — chart API de tickers `.BA` (fuente elegida)

```bash
# Endpoint verificado (200 + datos):
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/GGAL.BA?range=5d&interval=1d" \
  -H "User-Agent: Mozilla/5.0"
```

| Criterio | Resultado verificado |
|---|---|
| Acceso | Público, **sin API key**. **NO es una API oficial** — Yahoo Inc. no ofrece una API pública para developers ("Yahoo does not provide any official API to developers, nor makes any guarantees regarding service availability or API consistency", según el propio mantenedor de la lib) |
| Lib Node/TS | Tampoco hay lib oficial. La de facto es [`yahoo-finance2`](https://github.com/gadicc/yahoo-finance2) — **no oficial, community-mantained** (gadicc + pilwon, predecesor activo desde 2013), MIT, TypeScript nativo, ~157k descargas semanales, v4 publicada como `yahoo-finance2@latest` (la v3/4 cambió el init a `new YahooFinance()`) |
| Cobertura seed | **63/65** con mapping de símbolos (§4). Fallan solo PGR e IRCP, delistadas reales 2022. **Decisión del challenge: sin mapping → 61/65 (§4)** |
| Campos | `meta.regularMarketPrice` (close) + `meta.chartPreviousClose` (prev close), moneda `ARS` |
| Histórico | Incluido en el mismo endpoint: `range=5d|1mo|1y&interval=1d` (útil para volatilidad/validación) |
| Serie | Los `.BA` devuelven precios **nominales** en ARS (no ajustados por inflación ni por suscripciones de capital — coherente con la semántica `close` del challenge) |

El riesgo de una API no oficial se acota con tres decisiones:

- **El adaptador usa `fetch` con `User-Agent` propio y validación Zod**, timeout de 5 s y sin reintentos: una falla se traduce a 503 y el reintento queda del lado del cliente. La lib de facto `yahoo-finance2` no se incorpora.
- **UC-1/3/4/5 no dependen del proveedor**: el precio de referencia sale de `marketdata`, así que una caída de Yahoo afecta sólo a la búsqueda.
- Yahoo borra símbolos renombrados **sin rastro** (404 ni historial): el sistema no mapea renombradas (§4) y un ticker expirado queda sin precio.

### 2.2 Rava Bursátil API v5 (`api5.rava.com`) — alternativa oficial

| Criterio | Resultado verificado |
|---|---|
| Acceso | Bearer API key. 401 sin key. **El modo de obtención NO está documentado públicamente** |
| Docs | OpenAPI 3.1 público en `api.rava.com/openapi.json`; paneles `LID` (~23) / `GEN` (~59) / `LIDGEN` mapean 1:1 al universo del seed |
| Endpoints | `/cotizaciones` (tiempo real) + `/historicos` (cierre diario) |
| Calidad | Excelente: Rava es agente CNV, fuente directa de BYMA |

No es la fuente del sistema por la fricción de obtención de la key, no por precio ni
calidad: queda como alternativa si se exige una fuente oficial del mercado local.

### 2.3 DolarAPI (`dolarapi.com/v1/dolares`) — complemento

- 200 verificado, sin key, sin rate-limit conocido. Oficial / Blue / MEP / CCL con `fechaActualizacion`.
- **No sirve para precios de acciones** — útil si más adelante se quiere exponer valuación de portfolio en USD.

### 2.4 BYMA open API free tier (`open.bymadata.com.ar`) — descartada para precios

Fuente oficial (la mejor calidad/seguridad del marco) pero **no viable para el challenge**:

```bash
# OJO: solo acepta POST — GET devuelve 405 Method Not Allowed
curl -s -X POST "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/leading-equity" \
  -H "Content-Type: application/json" -d '{}'
```

| Prueba | Resultado |
|---|---|
| `GET /free/index-price` | 405 (requiere POST) |
| `POST /free/index-price` | 200 ✅ índices con `previousClosingPrice` |
| `POST /free/leading-equity` | 200 ✅ pero **solo 20 tickers** (panel líder) y **todos los precios en cero** (`closingPrice: 0E-8`) |
| `POST /free/equity-market` | 401 — requiere auth de cuenta |

- El free tier no expone precios reales (requiere suscripción BYMADATA).
- Estructura correcta (`previousClosingPrice`, `denominationCcy: ARS`, decimals) pero sin contenido utilizable.
- Duplica cada símbolo 2× (una fila por `sessionType`).
- **Uso residual:** fuente de **metadatos** (nombres/descripciones de instrumentos), no de precios.

### 2.5 Otras descartadas (con verificación)

| Fuente | Motivo verificado |
|---|---|
| ArgentinaDatos API | `/v1/titulos/*` → 404. Pivoteó a macro (dólar, inflación, riesgo país, aranceles de brokers). Ya no publica cotizaciones de acciones |
| wallstreetbets.com.ar | Conexión fallida (curl `000`, con y sin www). Fuente muerta o bloqueada |
| InvertirOnline API | Documentada con sandbox, pero exige cuenta de inversión abierta + activación manual por el broker. Fricción injustificada para el challenge |
| Scraping rava.com / mercado.com.ar | Frágil, sin contrato, redundante con Rava API |
| BYMA comercial (data vendor) | Requiere acuerdo comercial, no es público |

## 3. Fuente elegida y alternativas

| # | Fuente | Acceso | Cobertura | Rol |
|---|---|---|---|---|
| 1 | Yahoo Finance chart API (`.BA`) | Público, sin key | 63/65 | **Precios** de UC-2: `close` + `previousClose` por request |
| 2 | Rava API v5 | Bearer key (no documentada) | ~completa | Alternativa si se exige fuente oficial |
| 3 | DolarAPI | Público, sin key | Solo FX | Complemento (valuación en USD) |
| 4 | BYMA open free | Público, sin key | 20/65, precios en cero | Metadatos de instrumentos |

## 4. Tickers sin precio — verificados uno por uno

Los 4 tickers sin precio en Yahoo fueron verificados con búsquedas externas
(CNV, Caja de Valores, LSE RNS, BYMA, prensa). **No son huecos de la fuente:**

| Ticker | Veredicto | Causa (evidencia) | Resolución |
|---|---|---|---|
| `DYCA` Dycasa S.A. | ✅ **No delistada — renombrada** | OPA de Inversora Mercedes S.A. (anuncio nov 2024, autorizada por CNV res. NO-2025-18202898, comunicado Caja de Valores N° 12320 del 27/2/2025). La sociedad pasó a llamarse **IEB Construcciones S.A.** | Yahoo eliminó `DYCA.BA` (404 sin historial); queda un legado vacío `DYCA5.BA`. El sucesor **`IEB.BA` cotiza viva** (verificado: price 1980). Mapping `DYCA → IEB.BA` |
| `MTR` Matba Rofex S.A. | ✅ **No delistada — renombrada** | Fusión MTR + MAE → **A3 Mercados S.A.** (asambleas extraordinarias 20/11/2024, canje de acciones por Caja de Valores el 5/3/2025, cotiza en BYMA desde 5/3/2025 con ticker `A3`) | Yahoo eliminó `MTR.BA` (404). El sucesor **`A3.BA` cotiza viva** (verificado: price 2580). Mapping `MTR → A3.BA` |
| `PGR` Phoenix Global Resources | ❌ **Delistada real** | La mayoría (Mercuria) la llevó a privada: cancelación de AIM y de la BCBA anunciada en 2022, re-registro como sociedad privada + OPA de salida en cash para minoritarios. Sin sucesor cotizante | Sin precio posible |
| `IRCP` IRSA Propiedades Comerciales | ❌ **Delistada real por absorción** | Fusión por absorción en IRSA Inversiones y Representaciones (aprobada 2021, completada 9/5/2022; canje 1.4 IRSA por cada IRCP; retirada de oferta pública) | Sucesor `IRSA.BA` ya existe como instrumento propio en el seed |

**Cobertura final de Yahoo con mapping: 63/65** (solo PGR e IRCP sin precio — ambas
delistadas reales de 2022).

### Política de símbolos

- **Los faltantes no requieren conversión ni ingesta especial.**
- `DYCA`/`MTR` tienen sucesores vivos (`IEB.BA` / `A3.BA`, verificado), pero la
  **decisión es no mapearlos** (2026-11-02): sin tabla de símbolos; un ticker expirado o
  renombrado queda sin precio y el contrato lo omite. Cobertura efectiva: **61/65**. Este
  análisis documenta los mapeos disponibles; el contrato no los usa.
- `PGR`/`IRCP`: instrumentos históricos sin mercado. Se mantienen en `instruments` sin
  `marketdata` y la búsqueda los omite.

## 5. Reglas de la fuente

1. La fuente devuelve **floats**: el borde los convierte a `FinancialDecimal` desde string con validación estricta y nunca persiste el float crudo.
2. Un ticker que muere (404 en la fuente) **no rompe la API**: el contrato lo omite del listado y UC-1/3/4/5 siguen leyendo el último snapshot de `marketdata`.
3. Símbolo derivado directo: `ticker + ".BA"`, **sin tabla de mapping** (decisión
   2026-11-02). Las renombradas (`DYCA→IEB.BA`, `MTR→A3.BA`) no comparten substring con su
   sucesor y la search API de Yahoo no las resuelve sola: un mapping sería una tabla mantenida
   en el repo, no descubrimiento dinámico (ver §4).
4. Las delistadas reales no son un error de integración: son una política explícita de la spec.

## 6. Verificación reproducible

```bash
# Cobertura de Yahoo sobre el universo del seed (extraer tickers del bloque
# COPY public.instruments — NO con regex suelto sobre todo el seed.sql)
python3 - <<'EOF'
import urllib.request, json, re
seed = open('db/seed.sql').read()
block = seed.split('COPY public.instruments')[1].split('\\.')[0]
tickers = sorted(set(re.findall(r'^\d+,([A-Z0-9]+),', block, re.M)))
for t in tickers:
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{t}.BA?range=5d&interval=1d'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        m = json.load(urllib.request.urlopen(req, timeout=10))['chart']['result'][0]['meta']
        print(t, 'OK' if m.get('regularMarketPrice') else 'NOPRICE')
    except Exception:
        print(t, 'ERR')
EOF

# BYMA open free: POST obligatorio (GET → 405)
curl -s -X POST "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/leading-equity" \
  -H "Content-Type: application/json" -d '{}'

# DolarAPI
curl -s "https://dolarapi.com/v1/dolares"
```
