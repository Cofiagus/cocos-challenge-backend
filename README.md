# Cocos Challenge — Backend

API REST para consultar portfolios de usuarios, buscar instrumentos y enviar órdenes al mercado.

> Repositorio de base para la resolución del challenge técnico. El stack y la estructura se definen en las secciones de abajo a medida que avanza la implementación.

## Alcance funcional

- **Portfolio**: consultar las tenencias de un usuario (cash y posiciones por instrumento).
- **Instrumentos**: búsqueda por ticker o nombre.
- **Órdenes**: envío de órdenes de compra/venta `MARKET` y `LIMIT`, y cancelación de órdenes en estado `NEW`.
- **Transferencias**: modeladas como órdenes con side `CASH_IN` / `CASH_OUT`.

Reglas de negocio conocidas:

- Los precios están expresados en pesos.
- Las órdenes `MARKET` se ejecutan de inmediato.
- Las órdenes `LIMIT` quedan en estado `NEW` al crearse.
- Sólo se pueden cancelar órdenes en estado `NEW`.

## Stack

_Pendiente de definir._

| Capa | Tecnología |
| ---- | ---------- |
| Runtime | |
| Framework HTTP | |
| Base de datos | PostgreSQL |
| ORM | |
| Testing | |

## Requisitos

- Node.js 20+ (si aplica)
- Docker + Docker Compose (para la base de datos)
- PostgreSQL 15+

## Puesta en marcha

```bash
git clone <url-del-repo>
cd cocos-challenge-backend
```

_Pendiente: instalación de dependencias, variables de entorno y migraciones._

## Variables de entorno

Crear un archivo `.env` en la raíz (no se versiona). Referencia esperada:

```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/cocos_challenge
```

## Endpoints previstos

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| `GET` | `/api/users/portfolio?userId=1` | Portfolio del usuario |
| `GET` | `/api/instrument/search?q=TECO` | Búsqueda de instrumentos |
| `POST` | `/api/orders` | Enviar una orden al mercado |
| `DELETE` | `/api/orders` | Cancelar una orden en estado `NEW` |

Ejemplo de creación de orden:

```json
{
  "instrumentId": 54,
  "userId": 1,
  "side": "BUY",
  "type": "LIMIT",
  "size": 1,
  "price": 150
}
```

## Decisiones de diseño

_Documentar acá las decisiones relevantes: modelo de datos, manejo de concurrencia al debitar cash, validaciones, estrategia de tests._

## Estructura del proyecto

_Pendiente._

## Tests

_Pendiente._

## Autor

David — [@Cofiagus](https://github.com/Cofiagus)
