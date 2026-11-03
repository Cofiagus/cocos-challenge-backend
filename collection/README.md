### Colección REST Client — cocos-challenge-backend

Archivos `.http` para el **REST Client de VS Code** (extensión `humao.rest-client`): abri el
archivo, parate sobre el request y usá *"Send Request"* (Ctrl+Alt+R / Cmd+Alt+R). Sin Postman.

**Contra una base con el seed cargado** (`npm run dev` con el `.env` apuntando a la base del
quickstart del `README.md`). Los `id` de las respuestas nuevas (órdenes creadas) son
autoincrementales: arrancan después del 11 (el seed trae 11).

Orden sugerido (algunos ejemplos mutan estado y los idempotency keys se gastan):

```
01-portfolio.http    # lecturas del portfolio (200 + 404 de usuario)
02-instruments.http  # búsqueda (200 + array plano + 400 de query vacía)
03-orders.http        # envío de órdenes: éxito, rechazos de negocio, idempotencia y errores de borde
04-cancel.http        # cancelación: 200 de una NEW, 404 y 422
05-transfers.http     # transferencias: CASH_IN / CASH_OUT / rechazos
```

> Verificación: **todos** los requests de los 5 archivos fueron corridos en este orden contra
> el server levantado en una base recién migrada+seedada (curl equivalente, respuesta a
> respuesta): los estados y bodies documentados en los comentarios son los reales de esa
> corrida. Extra verificado: tras `04-cancel.http`, el `reservedCash` del portfolio baja de
> 125500 a 90000 (liberación de la reserva de la orden 5).
