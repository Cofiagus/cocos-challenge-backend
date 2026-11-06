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
   El ejemplo trae `?sslmode=require`; si tu PostgreSQL no usa SSL, quitá ese parámetro.
2. Instala dependencias y genera el cliente Prisma.
3. Carga `.env` en el shell y aplica las migraciones versionadas (`prisma/migrations/`) más los datos
   del challenge (`db/seed.sql`). `psql` no acepta todos los parámetros de URL que Prisma sí (por
   ejemplo `?schema=public`), por eso el comando recorta el query string. El seed **modifica datos**:
   no lo corras sobre una base que quieras conservar.
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
| [docs/schema-changes.md](docs/schema-changes.md) | cada cambio frente al esquema provisto por el challenge, con su motivo |

## Cómo funciona

Cada regla está decidida y fundamentada en [DECISIONS.md](DECISIONS.md), con su contexto y sus
consecuencias. Acá, la versión operativa:

- **El dinero viaja como string.** Entra como string decimal estricto y sale como string con
  2 decimales. Un JSON `number` se rechaza con 400: el parser ya pudo perder cifras antes de que la
  aplicación vea el dato (D1).
- **Cash y posiciones se derivan de `orders`.** No hay tabla de saldos, así que no pueden
  desincronizarse: `orders` es la única fuente de verdad. `cash` es el disponible
  (`settled − reservado`) y `reservedCash` viaja aparte para que la resta sea auditable (D2).
- **El precio de referencia es la última fila de `marketdata` por `date`.** `MARKET` se ejecuta
  contra ese precio y queda `FILLED` en la misma transacción. `LIMIT GTC` queda `NEW` y reserva.
  `IOC`/`FOK` se evalúan una sola vez: si cruza, se ejecuta con mejora (BUY paga
  `min(límite, referencia)`, SELL cobra `max(límite, referencia)`); si no cruza, `CANCELLED` con
  `NO_IMMEDIATE_MATCH`. Sin precio no se inventa uno (D3).
- **Las órdenes `NEW` no se ejecutan solas.** No hay motor de matching continuo: `matchRestingOrders`
  está implementada y testeada como punto de enchufe, y ningún flujo de producción la dispara (D3).
- **Una transferencia es una orden del instrumento `ARS`**, con precio unitario `"1.00"`, y mueve el
  monto exacto con centavos: `"0.01"` es una transferencia válida (D4).
- **La idempotencia se resuelve en la base, con lock por usuario.** Con `Idempotency-Key`: misma key
  y mismo payload devuelve la orden original; misma key y otro payload responde 409. Sin key, cada
  request crea una orden nueva (D5).
- **`201` también para `REJECTED` y `CANCELLED` persistidas**: el endpoint recibió, evaluó y grabó la
  orden. Un input inválido es 400 sin escribir nada (D6).
- **`MONEDA` no es operable**: no se compra, no se vende, no aparece en la búsqueda ni en las
  posiciones (D6).

## Calidad

Un cambio se cierra con `npm run typecheck` (`tsc --noEmit`, ESM con `module=nodenext`) y
`npm run lint` (ESLint 9 flat config) sin errores, más los tests de lo que se tocó. Para correrlo
todo:

```bash
npm run test:db:reset && npm test     # suite completa (requiere .env.test con TEST_DATABASE_URL)
npm run test:no-db                    # unit + docs + smoke ESM, sin tocar la base
```

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
