# Cocos Challenge — Backend

API REST en TypeScript para operar una cuenta de inversión: consultar el portfolio de un usuario,
buscar instrumentos, enviar órdenes al mercado, cancelarlas y registrar transferencias de cash.

## Qué expone

Base: `http://localhost:3000/api` · JSON · errores de la API siempre `{ "error": { "code", "message" } }`.

| Endpoint | Qué hace |
| -------- | -------- |
| `GET /users/:userId/portfolio` | cash disponible, cash reservado, patrimonio total y posiciones con su valor de mercado |
| `GET /instruments?query=<texto>&limit=<1..100>` | búsqueda parcial por ticker o nombre, con la cotización actual de cada instrumento |
| `POST /users/:userId/orders` | envía una orden `BUY`/`SELL` `MARKET`/`LIMIT` y la persiste con su estado (`FILLED`, `NEW`, `REJECTED`, `CANCELLED`) |
| `DELETE /orders/:orderId` | cancela una orden en estado `NEW` y libera su reserva |
| `POST /users/:userId/transfers` | `CASH_IN` / `CASH_OUT` sobre el saldo del usuario |

No hay tabla de cash ni de posiciones: ambas son proyecciones de `orders` (ver `DECISIONS.md`, D2).
Los dos probes de ciclo de vida (`GET /health`, `GET /health/ready`) viven fuera de `/api` y están
descritos en [docs/api.md](docs/api.md).

## Levantarla (4 comandos)

Requiere Node.js ≥ 22 y un PostgreSQL accesible. `psql` hace falta para cargar el seed.

```bash
cp .env.example .env
npm install && npx prisma generate
set -a && . ./.env && set +a && npx prisma migrate deploy && psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -q -f db/seed.sql
npm run dev
```

1. `.env.example` sólo muestra el formato: reemplazá el placeholder de `DATABASE_URL` por tu base.
2. Instala dependencias y genera el cliente Prisma.
3. Carga `.env` en el shell y aplica las migraciones versionadas (`prisma/migrations/`) más los datos
   del challenge (`db/seed.sql`). `psql` no acepta el `?schema=public` que Prisma sí entiende, por eso
   el comando recorta el query string. El seed **modifica datos**: no lo corras sobre una base que
   quieras conservar.
4. Levanta la API en `http://localhost:3000`.

Verificación contra la base recién seedeada:

```bash
curl http://localhost:3000/api/users/1/portfolio
# → 200 con "totalAccountValue": "889756.00"
```

Para tests hace falta una base aparte: copiá `.env.test.example` a `.env.test`, completá
`TEST_DATABASE_URL` y corré `npm run test:db:reset` antes de la suite (el reset elimina y recrea
las bases de test; nunca uses ahí la URL de la app).

## Documentación

| Documento | Para qué |
| --------- | -------- |
| [docs/api.md](docs/api.md) | semántica de cada endpoint: estados, invariantes, precedencia de validación, cuándo usar cada uno |
| [openapi.json](openapi.json) | contrato exacto: campos, tipos, status y códigos de error (generado desde los schemas Zod con `npm run openapi`) |
| [DECISIONS.md](DECISIONS.md) | las seis decisiones de arquitectura, cada una con contexto, decisión y consecuencias |
| [docs/database.md](docs/database.md) | esquema real, semántica de `orders` y diferencia entre el snapshot legacy y el head versionado |

## Supuestos (resumen)

El detalle y las consecuencias de cada uno están en [DECISIONS.md](DECISIONS.md); acá, la versión de
una línea:

- **El dinero nunca es `number`.** Entra como string decimal estricto y sale como string con
  2 decimales; un JSON `number` se rechaza con 400 porque el parser ya pudo perder cifras (D1).
- **Cash y posiciones se derivan de `orders`**, no de tablas propias: una sola fuente de verdad
  evita saldos desincronizados. `cash` es el disponible (`settled − reservado`) (D2).
- **Precio de referencia = última fila de `marketdata` por `date`.** `MARKET` se ejecuta ahí y queda
  `FILLED` en la misma transacción; `LIMIT GTC` queda `NEW` y reserva; `IOC`/`FOK` se evalúan una vez
  contra esa referencia. Sin precio, nunca se inventa uno (D3).
- **No hay motor de matching continuo:** `matchRestingOrders` existe testeada pero ningún flujo de
  producción la llama, así que las órdenes `NEW` no se llenan cuando cambia el precio (D3).
- **Una transferencia es una orden del instrumento `ARS`** (`price = "1.00"`) y mueve el monto exacto
  con centavos, sin floor: `"0.01"` es válida (D4).
- **Idempotencia opcional por `Idempotency-Key`**, con lock por usuario: misma key y mismo payload
  devuelve la orden original; misma key y otro payload responde 409 (D5).
- **`201` también para `REJECTED`/`CANCELLED` persistidas**: el endpoint recibió, evaluó y grabó la
  orden. Input inválido es 400 sin escribir nada (D6).
- **`MONEDA` no es operable**: no se compra, no se vende, no aparece en búsqueda ni en posiciones (D6).

## Estado del build

| Medición | Suites / tests |
| -------- | -------------- |
| `npm test` — suite completa contra PostgreSQL de test | **PENDIENTE-CIERRE** |
| `npm run test:no-db` — unit + docs + smoke ESM, sin base | **PENDIENTE-CIERRE** |

Este README es la **única fuente** de esos conteos: los completa la corrida final de la Fase 5. No se
repiten cifras de corridas anteriores porque quedaron viejas. Para reproducirlos:

```bash
npm run test:db:reset && npm test     # requiere .env.test con TEST_DATABASE_URL
npm run test:no-db                    # no toca la base
```

Gates de calidad, independientes de los conteos: `npm run typecheck` (`tsc --noEmit`, ESM con
`module=nodenext`) y `npm run lint` (ESLint 9 flat config).

## Estructura

```
src/contracts/     # schemas Zod de request/response, enums y dinero — fuente de openapi.json
src/domain/        # funciones puras: cash, posiciones, reservas, sizing, matching
src/application/   # casos de uso: portfolio, órdenes, cancelación, transferencias
src/infra/         # repos Prisma, transacciones y adaptador de cotizaciones de Yahoo
src/http/          # routers, borde de validación, manejador de errores y server
prisma/            # schema.prisma (DDL y índices) + migrations/
db/                # seed.sql del challenge; schema.sql es un snapshot legacy desactualizado
tests/             # unit / integration / functional / docs
```

## Autor

David — [@Cofiagus](https://github.com/Cofiagus)
