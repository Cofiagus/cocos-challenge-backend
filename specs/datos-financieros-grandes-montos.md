# Spec — datos financieros para grandes montos

> **Estado: implementada. D1–D5 son decisiones vigentes del sistema.**
> Alcance: ampliar la capacidad monetaria y su manejo en código y DB; UUID queda expresamente fuera de alcance.
> Verificación: suites de integración contra PostgreSQL de test, typecheck y lint.

## Why

Ampliar solamente las columnas de precios no garantiza que un monto grande sobreviva al recorrido HTTP → dominio → Prisma → PostgreSQL → HTTP.

Hoy los precios usan Decimal(10,2), el monto de entrada comparte ese límite y `orders.size` es INTEGER tanto para acciones como para pesos de transferencias. Además, Decimal opera con precisión 20 por defecto, la salida monetaria se convierte a number y las transferencias aplican floor a pesos enteros. Una sonda de verificación reprodujo pérdida de un centavo en serialización y redondeo incorrecto al operar en el rango propuesto.

Evidencia reproducida, referencias de código y alternativas: `docs/references/precision-datos-financieros.md`. El análisis no amplía el alcance por sí mismo.

**Objetivo:** representar, validar, calcular y persistir grandes importes con centavos, sin truncamiento monetario silencioso, sin overflow que termine como un 500 evitable y sin modificar la identidad de los usuarios.

## What

### 1. Decisiones aprobadas por el usuario

| ID | Propuesta recomendada | Motivo y costo |
|---|---|---|
| D1 | Dinero almacenado en **NUMERIC(24,2)**; cálculo con constructor Decimal financiero de **64 cifras significativas**. | Máximo por importe/precio: `9999999999999999999999.99`. Es un límite técnico propuesto, no una regla de negocio aportada por el usuario ni capacidad infinita. |
| D2 | Ampliar **orders.size de INTEGER a NUMERIC(24,2)**; conservar dos unidades físicas según side y separarlas en tipos de dominio. No agregar columnas ni tablas. | Es el cambio sobre campos existentes que permite cash grande y centavos. Mantiene la deuda del campo físico de doble propósito; no la oculta en el código. Acciones siguen enteras y acotadas a INT4 por orden. |
| D3 | Dinero de entrada y salida como **strings decimales**; quantity agregada como string entero; size de trading sigue number entero acotado. | Evita pasar importes/cantidades agregadas por number. Es un **cambio incompatible del contrato HTTP vigente**, no una corrección transparente. Porcentajes e IDs no cambian de representación. |
| D4 | Las nuevas transferencias mueven el **monto exacto con centavos**, sin floor. Las órdenes BUY/SELL conservan floor para convertir monto a acciones. | Corrige la limitación de cash entero. Cambia la semántica vigente de UC-5 y exige compatibilidad explícita de replays históricos, sin modificar el dinero ya movido. |
| D5 | Migración coordinada con pausa de escrituras y **excepción acotada** para personalizar sólo la nueva migración aún no aplicada con CHECKs. | AGENTS.md prohíbe editar migrations a mano. No se elude esa regla: hace falta autorización y registrar la excepción antes de ejecutar. No se promete despliegue rolling ni downtime cero. |

La validación de D1–D5 es vigente. Si cambia precisión, representación o política de transferencias, se requiere una nueva revisión y validación antes de cambiar código.

### 2. DB: campos, unidades y garantías

Con D1/D2 aprobadas:

| Campos | Actual | Propuesto | Unidad / semántica |
|---|---|---|---|
| orders.price, orders.filledPrice | NUMERIC(10,2) | NUMERIC(24,2) | ARS por acción; en cash se mantiene el precio unitario histórico de 1.00 ARS. Conservar NULL donde corresponde. |
| marketdata.high, low, open, close, previousClose | NUMERIC(10,2) | NUMERIC(24,2) | ARS por acción. Conservar nombres físicos/mapeos y nullabilidad. |
| orders.size para BUY/SELL | INTEGER | NUMERIC(24,2), **entero almacenado** | Cantidad de acciones, sin fracciones; por orden 1..2147483647, o 0 en un REJECTED compatible con las reglas existentes. |
| orders.size para CASH_IN/CASH_OUT | INTEGER, pesos | NUMERIC(24,2), pesos | Monto de cash en ARS; para nuevas solicitudes >0, hasta el máximo D1, con centavos. |
| IDs, FKs y secuencias | INTEGER | **Sin cambios** | No UUID, no BIGINT de identificadores, no regeneración de IDs. |

**CHECKs acotados a los campos financieros modificados**, sujetos al preflight de datos:

- Todo precio no nulo debe ser finito; precio de orden positivo; marketdata no negativo, conservando el caso de precio cero ya contemplado por cálculo/validación.
- size no nulo debe ser finito y no negativo. En BUY/SELL debe ser entero y no superar el máximo de acciones por orden; size 0 sólo es compatible con REJECTED. En cash se permite cero únicamente para los REJECTED históricos de ZERO_SIZE, nunca para una nueva transferencia válida.
- Un NULL financiero ya permitido no se reemplaza por cero. Los campos requeridos para una fila operable se validan en aplicación/mappers; no se endurece toda la nullabilidad de tablas legacy en este trabajo.
- No se agregan constraints de email/ticker, nuevos índices, triggers de estados ni cambios al mecanismo de idempotencia.
- **Límite honesto:** NUMERIC(24,2) puede redondear una entrada SQL con escala mayor antes de un CHECK. Zod debe rechazarla antes de persistir. Los CHECKs garantizan el valor almacenado, no reconstruyen la precisión original de una escritura SQL externa; no se promete esa garantía sin ampliar el diseño.

La fuente del DDL son schema Prisma y migraciones nuevas versionadas. No editar la migración inicial ni los snapshots SQL generados.

### 3. Código: representación y aritmética

1. **Una configuración financiera explícita.** Constructor Decimal propio mediante clone, precisión 64 y ROUND_HALF_UP; ubicado en contratos para que dominio/infra lo consuman sin invertir dependencias. No mutar globalmente la configuración de un paquete desde el arranque ni depender del orden de imports. Los mappers reconstruyen los decimales por string con este constructor antes de operar.
2. **Una sola definición de rango y gramática monetaria en contratos.** El espejo OpenAPI la reutiliza; se elimina la segunda constante independiente de máximo. DB y código se contrastan mediante pruebas de integración, no se hace depender el dominio del cliente Prisma.
3. **Tipos discriminados por side.** BUY/SELL exponen internamente sizeShares entero; CASH_IN/CASH_OUT exponen amountArs Decimal, aunque ambos se mapeen a la columna física size. No `number | Decimal` ambiguo usado como acciones en todos los caminos ni `any`. Las proyecciones FILLED de cash devuelven un monto, no acciones ficticias.
4. **Sumas/productos exactos dentro del presupuesto soportado.** Mantener dinero en Decimal financiero y cantidades agregadas/reservas en bigint. Las cantidades por orden siguen number seguro dentro del rango aprobado; convertir a Decimal por string y a bigint sólo después de validar que son enteros seguros. Adaptar portfolio, reservas, promedio y validaciones de SELL.
5. **Sizing defensivo.** BUY/SELL calcula floor en Decimal, valida 0 y máximo **antes** de convertir a number. Si el size derivado supera 2147483647: 400 VALIDATION_ERROR y ninguna escritura, incluida una orden REJECTED. Si da 0, conservar REJECTED ZERO_SIZE. La nueva rama cash no llama al sizing de acciones.
6. **Divisiones y redondeo explícitos.** Promedio/P&L pueden tener expansión periódica: se calculan con precisión 64, sin cuantizar cada paso. Dinero se cuantiza a dos decimales al presentar; porcentajes conservan su contrato numérico y se convierten sólo en su serializador, con finitud validada. No afirmar exactitud infinita de divisiones.
7. **No confundir precio, notional y saldo.** D1 acota cada precio/monto solicitado y el cash de cada fila; price × size, reservas y totales calculados pueden superarlo sin ser inválidos. No reutilizar el máximo de una columna como límite accidental del patrimonio ni redondear un producto a través de number.

La evidencia calcula 43 cifras para un presupuesto de precio máximo × acciones máximas por orden × máximo positivo INT4 de órdenes. Precisión 64 ofrece margen para esos productos/sumas; cambiar límites de cantidades/IDs exige recalcular este presupuesto. Esto no es un compromiso de rendimiento para ese volumen.

### 4. Contrato HTTP propuesto — cambio incompatible y coordinado

- **Entrada monetaria:** string decimal de base 10, hasta 22 dígitos enteros y dos decimales; punto decimal, sin exponente, separadores, signo `+`, espacios ni ceros iniciales salvo el propio 0. Rechazar números JSON incluso pequeños: la aplicación no puede recuperar cifras que el parser ya haya perdido. Price/amount de operaciones válidas deben ser positivos.
- **Salida monetaria:** strings con exactamente dos decimales, sin notación científica ni `-0.00`; conservar NULL donde hoy significa ausencia. Abarca cash, reservedCash, totalAccountValue, marketValue, price, filledPrice y previousClose. El esquema de salida permite resultados agregados mayores al máximo de una fila.
- **OrderResponse.size:** discriminado por side. BUY/SELL: number entero/null según el caso vigente. CASH_IN/CASH_OUT: string monetario — representa pesos, incluida la parte decimal. La respuesta de un cash histórico de size 123 se representa como `"123.00"`, sin cambiar el valor persistido. No se agrega otro campo monetario duplicado.
- **Portfolio.quantity:** string entero canónico, con signo para la posición negativa heredada. El bigint interno nunca se envía directamente a JSON. Esto preserva exactitud cuando muchas órdenes válidas acumulan cantidades superiores al entero seguro de JS.
- **Sin nuevas rutas ni versión paralela implícita.** Actualizar el contrato actual, clientes/ejemplos/tests y OpenAPI juntos sólo tras aprobar D3. No devolver number/string según el tamaño ni mantener dos formas monetarias silenciosamente.
- Los IDs, size de entrada de BUY/SELL, porcentajes y estados/status de casos de uso no cambian, salvo los rechazos técnicos de rango aquí especificados.

### 5. Cash exacto e idempotencia histórica

- CASH_IN nuevo acredita exactamente amountArs; CASH_OUT compara **ese monto exacto** contra el disponible leído dentro de la transacción. Persistirlo en size y conservar precio unitario 1.00; eventos con montos canónicos en string. Una transferencia de 0.01 es válida, no ZERO_SIZE.
- No reescribir size, precios ni eventos históricos para recuperar fracciones descartadas. Un CASH_IN histórico pedido por 123.45 pero representado por 123 pesos sigue moviendo 123.00 después de migrar. No regalar ni debitar los 0.45 al recalcular.
- Conservar UNIQUE(userId, idempotencyKey), INSERT ON CONFLICT como primera escritura, lock por usuario y orden+evento en la misma transacción.
- Dos transferencias nuevas con la misma key pero montos 123.01 y 123.99 deben dar 409, nunca colapsar por floor. `"123.0"` y `"123.00"` son el mismo monto.
- Para una key cash histórica, comparar también el monto original documentado en metadata.amountArs del evento de origen, con validación estricta de esa evidencia. Mismo pedido original: devolver la fila original, sin evento nuevo y sin reejecutar diferencias de centavos. Distinto: 409. Si una key histórica no tiene evidencia suficiente para establecer el pedido exacto, fallar conservadoramente con 409; no adivinar ni volver a mover fondos.
- Probar específicamente: key histórica que recibió 123.45 y persistió 123; retry 123.45 devuelve el movimiento original de 123.00; retry 123.99 es conflicto; nueva key por 123.45 persiste 123.45.

### 6. Migración y convivencia

1. **Preflight de sólo lectura**, en una copia/test aislado autorizado: inventariar size/precios nulos, cero, negativos, especiales, cash con precio distinto de 1.00 y keys cash sin evidencia de monto original. Registrar conteos y valores financieros de control, nunca credenciales ni datos personales en el informe. Si hay inconsistencias, detener y pedir una decisión; no normalizar por defecto.
2. Generar migración nueva desde schema con create-only. Revisar el cast INTEGER → NUMERIC y widening de los siete precios. Personalización de CHECKs sólo si D5 fue aprobada; no editar migraciones ya aplicadas.
3. Validar en DB de test migrada y en un clon con datos representativos: conservación exacta de valores, IDs, claves y eventos; mismo cash/posiciones/patrimonio del seed por valor, aunque cambie su forma JSON. El seed original debe cargar sin editarse sobre el esquema final.
4. Despliegue con pausa coordinada de escrituras y reemplazo de todas las instancias antiguas antes de habilitar cash fraccional/grande. El cliente viejo espera size Int y no es compatible con el nuevo tipo; no asumir convivencia rolling.
5. Medir locks y duración en el entorno de ensayo antes de fijar la ventana. Guardar backup y plan de restauración. No ejecutar migraciones sobre la DB de la app durante esta tarea de spec.
6. **Rollback:** antes de aceptar datos nuevos se puede restaurar el estado ensayado; después de almacenar fracciones/importes fuera del rango anterior no se permite un downgrade por cast/truncado. Requiere restauración/reconciliación aprobada, con costo y posible indisponibilidad explícitos.

## Constraints

- Alcance cerrado a capacidad monetaria y consistencia de representación/persistencia; no auth, UUID, logs, Docker, fuentes nuevas de precios, matching continuo ni optimizaciones generales de consultas.
- Sin tablas/columnas nuevas, saldos materializados, cambio de unidad a centavos almacenados, dinero en float ni dependencias nuevas en la propuesta recomendada.
- No resolver deuda histórica del modelo con defaults silenciosos ni modificar campos financieros/eventos anteriores. No mezclar cash con cantidades en cálculos nuevos.
- Mantener SQL parametrizado y las garantías transaccionales/idempotentes existentes. Una falla en evento revierte el movimiento completo.
- La spec **no** cambió por sí sola AGENTS.md, DECISIONS.md, contrato HTTP, schema ni tests: esos archivos se actualizaron junto con las decisiones D1–D5.
- Nuevos CHECKs no se aplican por fuera de migraciones revisadas ni se oculta su SQL en un script de arranque. Si no se autoriza D5, el alcance de garantías DB debe reabrirse; no entregar como implementado un CHECK inexistente.

## Tasks implementadas

Cada subtarea modifica **1–2 archivos**. Los bloques siguientes son secuencias, no autorización para un diff masivo. Los cambios de CODEMAP por archivos/exports deben ir en el **mismo commit** que las subtareas de código correspondientes; no es necesario que cada subtarea sea un commit independiente. TDD por criterio: registrar primero el rojo del caso nuevo y después el verde de la implementación; no desactivar assertions previas.

| ID | Archivos / corte atómico | Verificación requerida |
|---|---|---|
| T0a | DECISIONS.md + AGENTS.md | Reflejan salida string/transferencias y excepción exacta D5, sin alterar reglas no aprobadas. |
| T0b | specs/trading-api-domain.md | Actualiza sólo las reglas afectadas y referencia esta spec aprobada; ninguna aprobación histórica se inventa. |
| T1 | Nuevo src/contracts/financial-decimal.ts + nuevo tests/unit/large-money-arithmetic.test.ts | Precisión aislada 64; resta de un centavo, multiplicación grande, suma/cancelación exactas; no cambia Decimal global. |
| T2a | src/contracts/money.ts + tests/unit/money-input.test.ts | Strings válidos, máximo y máximo+0.01; number/exponente/no-finito/tercer decimal rechazados; máximo definido una vez. |
| T2b | src/contracts/money.ts + tests/unit/money-serialization.test.ts | Strings fijos exactos para grandes montos y agregados; cero/negativos/NULL del borde; porcentajes conservados. |
| T3 | src/contracts/domain.ts + src/contracts/index.ts | Uniones cash/trading y exports coherentes; no se usa un monto como sizeShares; typecheck sin any. |
| T4a | prisma/schema.prisma + nueva migración generada, aún no aplicada | Diff sólo de tipos aprobados; D5 antes de SQL custom; prisma validate y revisión de migración, sin tocar la inicial. |
| T4b | Nuevo tests/integration/infra/large-money-storage.test.ts | DB aislada: round-trip máximo/centavo, CHECKs con NaN y tamaños fraccionarios/rango; comparar seed antes/después y probar rollback. |
| T5 | src/infra/prisma/mappers.ts + tests/unit/infra/mappers-filled-price.test.ts | Decimal de size sin Number para cash; entero seguro para trading; fallback filledPrice/price intacto; NULL/corrupción falla ruidosamente. |
| T6a | src/infra/prisma/order-repository.ts + tests/integration/infra/order-repository.create-order.test.ts | INSERT directo/raw y lecturas guardadas conservan size decimal y parámetros; nueva fila + evento siguen atómicos. |
| T6b | src/infra/prisma/order-repository.ts + tests/integration/infra/order-repository.idempotency.test.ts | Montos nuevos distintos por centavo dan conflicto; replay histórico conserva valor original y no duplica eventos. |
| T7 | src/domain/sizing/index.ts + tests/unit/domain/sizing.test.ts | Cálculo Decimal antes de number; decisión de fuera de rango no produce entero inseguro; floor de trading preservado. |
| T8a | src/domain/portfolio/index.ts + tests/unit/domain/portfolio.test.ts | Cash exacto; cantidades/reservas bigint y promedio; valores grandes y sumas con centavos. |
| T8b | src/application/orders/decide-order.ts + tests/unit/application/decide-order.test.ts | Cantidades/reservas compatibles; error de sizing identificado antes de persistencia; ZERO_SIZE sigue siendo rechazo de negocio. |
| T9a | src/application/orders/submit-order.ts + src/application/orders/persist-order-decision.ts | 400 por size derivado fuera de rango sin escritura; draft discriminado y evento en misma tx. |
| T9b | src/application/transfers/submit-transfer.ts + tests/unit/application/submit-transfer.characterization.test.ts | 0.01, 123.45 y máximo exactos; CASH_OUT compara todo el monto; replays históricos según §5. |
| T10 | src/contracts/orders.ts + tests/unit/contracts-orders.test.ts | OrderResponse.size discriminado; size de entrada de trading conserva INT4; ningún cambio accidental a IDs/estados. |
| T11a | src/contracts/portfolio.ts + src/application/portfolio/get-portfolio.ts | quantity contractual string y cantidad interna exacta; dinero permanece Decimal hasta el borde. |
| T11b | src/http/shared/edge.ts + tests/unit/http/edge.test.ts | Strings monetarios y size cash exactos; size trading sigue entero; sin BigInt crudo en JSON. |
| T11c | src/http/portfolio/portfolio-router.ts + tests/unit/application/get-portfolio.test.ts | Salida quantity canónica, cash/patrimonio exactos, posiciones heredadas y sin precio preservadas. |
| T12a | scripts/openapi/wire.ts + scripts/openapi/registry.ts | Reutiliza contrato monetario y actualiza ejemplos sin duplicar límites; no cambia rutas/códigos no aprobados. |
| T12b | openapi.json regenerado + tests/docs/openapi.test.ts | Sincronización exacta y muestras de frontera entre wire/runtime; documenta cambio incompatible. |
| T13 | Subtareas por cada consumidor de Decimal/cantidades afectado, **un archivo de src y su test directo como máximo** | Migrar también matching puro y price-source sólo en tipos/construcción, sin activarlos; prohibir mezcla de constructor financiero/default y conversiones monetarias a number. Inventario se registra antes del primer cambio, no refactor general. |
| T14 | Subtareas de compatibilidad por cada fixture/suite afectada, **máximo dos archivos por subtarea** | Adaptar literales al contrato vigente, conservar escenarios/assertions y valores económicos; cubrir funcionales read/orders/orders-submit/transfers/cancel y conteo de eventos. No borrar/re-escribir suites para ocultar regresiones. |
| T15a | docs/CODEMAP.md + docs/database.md | Mapa de exports y tipos reales; unidades y limitaciones de DB correctas; acompaña el mismo commit del cambio que documenta. |
| T15b | docs/api.md + README.md | Contrato string, unidades de size, ejemplos exactos y procedimiento coordinado de migración. |
| T16 | Sin cambios de archivos: verificación y diff final | typecheck + lint + unit/docs + integración/funcionales contra TEST_DATABASE_URL; output real, ninguna DB de app alterada y ningún cambio ajeno al alcance. |

Antes de T13/T14, el inventario exacto se obtiene por imports/referencias y se divide en subtareas de 1–2 archivos, manteniendo esta misma semántica; si aparece una decisión de diseño nueva, se detiene para revisión en vez de incluirla como adaptación mecánica.

## Aceptación verificable

1. Precio/monto máximo D1 persiste y vuelve con sus centavos; máximo+0.01 y entrada con más escala se rechazan en API sin filas/eventos nuevos.
2. Se reproduce y corrige `90071992547409.93` sin convertirlo en `90071992547409.94`; restar 0.01 al máximo produce exactamente `9999999999999999999999.98`.
3. Transferencia nueva de 0.01 y de 123.45 mueve exactamente esos importes; CASH_OUT por un centavo sobre disponible se rechaza sin debitar.
4. Dos escrituras concurrentes con fondos que alcanzan para una sola no gastan dos veces; la auditoría y los replays siguen en la misma disciplina transaccional.
5. La cantidad derivada de BUY/SELL fuera de rango devuelve 400 sin INSERT; acciones fraccionarias no se almacenan como trading válido.
6. Cash/reservas/totalAccountValue pueden superar el máximo de una fila por agregación y seguir exactos; quantity agregada puede superar el entero seguro de JS sin contaminar marketValue.
7. El seed conserva sus valores financieros e IDs; no se acreditan centavos históricos faltantes. Los replays históricos de §5 no reejecutan movimientos.
8. La migración se prueba desde esquema viejo con datos y desde DB nueva + seed intacto. CHECKs inspeccionados en PostgreSQL, no sólo en mocks; rollback de una multi-escritura probado.
9. OpenAPI, ejemplos y consumidores de las suites usan el contrato aprobado, sin tipos de salida monetarios dependientes del tamaño.
10. Las verificaciones pasan con salida real: typecheck, lint y las suites de integración contra PostgreSQL de test.

## Decisiones vigentes

- [x] D1 — NUMERIC(24,2) y presupuesto Decimal 64.
- [x] D2 — Ampliar size a NUMERIC, conservar acciones INT4 por orden y separar cash/trading en tipos.
- [x] D3 — Cambio incompatible: dinero string, quantity agregada string y size de cash string; sin endpoint paralelo.
- [x] D4 — Nuevas transferencias exactas con centavos y política conservadora para keys históricas.
- [x] D5 — Migración coordinada y permiso puntual para personalizar sólo la nueva migración aún no aplicada.
