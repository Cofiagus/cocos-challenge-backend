# Fuentes de datos de mercado argentino — Análisis y verificación

> Análisis para el ingestor de precios del challenge. Verificado en vivo (2026-10-30)
> con llamadas reales contra cada fuente y cobertura medida contra el universo del
> seed (`db/seed.sql`). Estado del 2026-10 — re-probar antes de confiar.

## 1. Universo necesario

- 66 filas en `instruments`: 65 `ACCIONES` (panel líder + general, tickers BYMA) + 1 `MONEDA` (`ARS / PESOS` — no busca cotización).
- Campos requeridos por el challenge: `close` + `previousClose`, en **ARS** (columna `marketdata.close` del schema).
- **No se necesita tiempo real**: ingesta diaria (caché) es suficiente.

**Nota sobre el seed:** el universo del seed está **desactualizado** — contiene
instrumentos que ya no cotizan (ver §4). Decisión: los gaps no requieren conversión
ni ingesta especial; no son huecos de la fuente sino instrumentos muertos en la DB de
ejemplo.

## 2. Fuentes evaluadas

### ✅ 2.1 Yahoo Finance — chart API de tickers `.BA` (RECOMENDADA)

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

Mitigaciones del riesgo "API no oficial":

- Wrapper Node mantenido: [`yahoo-finance2`](https://github.com/gadicc/node-yahoo-finance2) (maneja crumbs/cookies/rate-limit).
- **Ingesta diaria cacheada en `marketdata`**: si la fuente cae, la API del challenge sigue respondiendo con el último snapshot.
- Yahoo borra símbolos renombrados **sin rastro** (404 ni historial): detectar vía `/v1/finance/search`; el challenge decide **no mapear** renombradas (§4).

### ⚠️ 2.2 Rava Bursátil API v5 (`api5.rava.com`) — plan B

| Criterio | Resultado verificado |
|---|---|
| Acceso | Bearer API key. 401 sin key. **El modo de obtención NO está documentado públicamente** |
| Docs | OpenAPI 3.1 público en `api.rava.com/openapi.json`; paneles `LID` (~23) / `GEN` (~59) / `LIDGEN` mapean 1:1 al universo del seed |
| Endpoints | `/cotizaciones` (tiempo real) + `/historicos` (cierre diario) |
| Calidad | Excelente: Rava es agente CNV, fuente directa de BYMA |

Descartada como primera opción **solo por fricción de obtención de la key** (no por
precio ni calidad). Es el plan B si el evaluador exige una fuente oficial del mercado
local y la key se consigue gratis.

### ✅ 2.3 DolarAPI (`dolarapi.com/v1/dolares`) — complemento

- 200 verificado, sin key, sin rate-limit conocido. Oficial / Blue / MEP / CCL con `fechaActualizacion`.
- **No sirve para precios de acciones** — útil si más adelante se quiere exponer valuación de portfolio en USD.

### ❌ 2.4 BYMA open API free tier (`open.bymadata.com.ar`) — descartada para precios

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

### ❌ 2.5 Otras descartadas (con verificación)

| Fuente | Motivo verificado |
|---|---|
| ArgentinaDatos API | `/v1/titulos/*` → 404. Pivoteó a macro (dólar, inflación, riesgo país, aranceles de brokers). Ya no publica cotizaciones de acciones |
| wallstreetbets.com.ar | Conexión fallida (curl `000`, con y sin www). Fuente muerta o bloqueada |
| InvertirOnline API | Documentada con sandbox, pero exige cuenta de inversión abierta + activación manual por el broker. Fricción injustificada para el challenge |
| Scraping rava.com / mercado.com.ar | Frágil, sin contrato, redundante con Rava API |
| BYMA comercial (data vendor) | Requiere acuerdo comercial, no es público |

## 3. Ranking final

| # | Fuente | Acceso | Cobertura | Rol |
|---|---|---|---|---|
| 1 | Yahoo Finance chart API (`.BA`) | Público, sin key | 63/65 | **Precios** (close + previousClose, ingesta diaria cacheada) |
| 2 | Rava API v5 | Bearer key (no documentada) | ~completa | Plan B si se exige fuente oficial |
| 3 | DolarAPI | Público, sin key | Solo FX | Complemento (valuación en USD) |
| 4 | BYMA open free | Público, sin key | 20/65, precios en cero | Metadatos de instrumentos |

## 4. Gaps del seed — verificados uno por uno

Los 4 tickers sin precio en Yahoo fueron verificados con búsquedas externas
(CNV, Caja de Valores, LSE RNS, BYMA, prensa). **No son huecos de la fuente:**

| Ticker | Veredicto | Causa (evidencia) | Fix |
|---|---|---|---|
| `DYCA` Dycasa S.A. | ✅ **No delistada — renombrada** | OPA de Inversora Mercedes S.A. (anuncio nov 2024, autorizada por CNV res. NO-2025-18202898, comunicado Caja de Valores N° 12320 del 27/2/2025). La sociedad pasó a llamarse **IEB Construcciones S.A.** | Yahoo eliminó `DYCA.BA` (404 sin historial); queda un legado vacío `DYCA5.BA`. El sucesor **`IEB.BA` cotiza viva** (verificado: price 1980). Mapping `DYCA → IEB.BA` |
| `MTR` Matba Rofex S.A. | ✅ **No delistada — renombrada** | Fusión MTR + MAE → **A3 Mercados S.A.** (asambleas extraordinarias 20/11/2024, canje de acciones por Caja de Valores el 5/3/2025, cotiza en BYMA desde 5/3/2025 con ticker `A3`) | Yahoo eliminó `MTR.BA` (404). El sucesor **`A3.BA` cotiza viva** (verificado: price 2580). Mapping `MTR → A3.BA` |
| `PGR` Phoenix Global Resources | ❌ **Delistada real** | La mayoría (Mercuria) la llevó a privada: cancelación de AIM y de la BCBA anunciada en 2022, re-registro como sociedad privada + OPA de salida en cash para minoritarios. Sin sucesor cotizante | Sin precio posible |
| `IRCP` IRSA Propiedades Comerciales | ❌ **Delistada real por absorción** | Fusión por absorción en IRSA Inversiones y Representaciones (aprobada 2021, completada 9/5/2022; canje 1.4 IRSA por cada IRCP; retirada de oferta pública) | Sucesor `IRSA.BA` ya existe como instrumento propio en el seed |

**Cobertura final de Yahoo con mapping: 63/65** (solo PGR e IRCP sin precio — ambas
delistadas reales de 2022).

### Política para los gaps

- **El seed está desactualizado: los gaps NO requieren conversión ni ingesta especial.**
- `DYCA`/`MTR` tienen sucesores vivos (`IEB.BA` / `A3.BA`, verificado), pero la
  **decisión del challenge es no mapearlos** (validada con el usuario,
  2026-11-02): sin tabla de símbolos; un ticker expirado o renombrado queda sin
  precio y el ingestor lo salta. Cobertura efectiva del plan: **61/65**. Este
  análisis queda como evidencia por si el challenge pidiera cobertura 65/65.
- `PGR`/`IRCP`: instrumentos históricos sin mercado. Decisión de política del ingestor:
  mantener el instrumento en `instruments` sin `marketdata` fresco (o marcarlo inoperable).

## 5. Reglas de ingesta (independientes de la fuente)

1. La fuente devuelve **floats** → convertir a **centavos enteros / Decimal desde string** en el borde de ingesta, con validación estricta. Nunca persistir el float crudo.
2. Un ticker que muere (404 en la fuente) **no debe romper la API**: el último snapshot de `marketdata` sigue sirviendo (caché).
3. Símbolo derivado directo: `ticker + ".BA"`, **sin tabla de mapping** (decisión
   2026-11-02). Nota de por qué existió la idea: las renombradas (`DYCA→IEB.BA`,
   `MTR→A3.BA`) no comparten substring con su sucesor y la search API de Yahoo no
   las resuelve sola — si algún día se quisiera el mapping, tendría que ser tabla
   mantenida en el repo, no descubrimiento dinámico (ver §4).
4. Delistadas reales: no son un error de integración — política explícita en la spec.

## 6. Reproducir la verificación

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
