### Colección REST Client — cocos-challenge-backend

Archivos `.http` para el **REST Client de VS Code** (extensión `humao.rest-client`): abri el
archivo, parate sobre el request y usá *"Send Request"* (Ctrl+Alt+R / Cmd+Alt+R). Sin Postman.

**Contra una base con el seed cargado** (`npm run dev` con el `.env` apuntando a la base del
quickstart del `README.md`). Los `id` de las respuestas nuevas (órdenes creadas) son
autoincrementales: arrancan después del 11 (el seed trae 11).

Orden sugerido (algunos ejemplos mutan estado y los idempotency keys se gastan):

```
01-portfolio.http    # lecturas del portfolio (200 + 404 de usuario)
02-instruments.http  # búsqueda (200 + array plano + listado inicial con query vacía + omisión de tickers sin cotización)
03-orders.http        # envío de órdenes: éxito, rechazos de negocio, idempotencia y errores de borde
04-cancel.http        # cancelación: 200 de una NEW, 404 y 422
05-transfers.http     # transferencias: CASH_IN / CASH_OUT / rechazos
```

> **Contrato de grandes montos (spec aprobada `specs/datos-financieros-grandes-montos.md` Rev. 2):**
> el dinero entra como **string decimal estricto** (`"price": "900.00"`, `"amountArs": "123.45"`;
> un JSON `number` ⇒ 400) y sale como **string con 2 decimales**; `quantity` del portfolio es
> **string entero** y el `size` de la respuesta es `number` en órdenes de trading pero
> **string monetario** en transferencias. Los cuerpos y estados documentados en los comentarios
> describen ese contrato aprobado (y los valores del seed, que no cambian: cash disponible
> `627500.00`, reservado `125500.00`, total `889756.00`). El contrato está **implementado y
> verificado por suites automatizadas contra DB de test real**: el gate completo integrado quedó
> registrado en `../PROGRESS.md` (§ROLLOUT CERRADO: **42 suites / 581 tests en verde**, 19 de
> aceptación de grandes montos) y la evidencia del gate de la wave, con sus límites, en
> [`../docs/references/large-money-verification.md`](../docs/references/large-money-verification.md)
> (esa corrida fue sobre la candidata y midió 37 suites / 515 tests).
> La migración `20261105104903_large_money` **sí quedó aplicada** a la DB de la app
> `127.0.0.1:5433/cocos_challenge` (G3 en `../PROGRESS.md`: 2 migraciones aplicadas, 0
> `rolled_back`, los 6 CHECK verificados y 8 columnas `NUMERIC(24,2)`). Lo que **no** existe es una
> corrida manual íntegra de esta colección contra esa base: los estados de los comentarios salen
> de la suite automatizada. Los `id` de los comentarios siguen siendo ilustrativos.
