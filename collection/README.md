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

> **Contrato de grandes montos (spec aprobada `specs/datos-financieros-grandes-montos.md` Rev. 2):**
> el dinero entra como **string decimal estricto** (`"price": "900.00"`, `"amountArs": "123.45"`;
> un JSON `number` ⇒ 400) y sale como **string con 2 decimales**; `quantity` del portfolio es
> **string entero** y el `size` de la respuesta es `number` en órdenes de trading pero
> **string monetario** en transferencias. Los cuerpos y estados documentados en los comentarios
> describen ese contrato aprobado (y los valores del seed, que no cambian: cash disponible
> `627500.00`, reservado `125500.00`, total `889756.00`). La corrida verificada en vivo previa a
> esta feature se hizo contra el contrato anterior (dinero `number`): re-corregir la colección
> contra la implementación queda para la verificación final de la feature, no se afirma acá.
