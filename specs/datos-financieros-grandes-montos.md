# Spec — datos financieros para grandes montos

> **Estado: implementada. D1–D5 son decisiones vigentes del sistema.**
> Alcance: la capacidad monetaria y su manejo en código y DB; los identificadores no cambian.
> Verificación: suites de integración contra PostgreSQL de test, typecheck y lint.

## Motivo

Ampliar solamente las columnas de precios no garantiza que un monto grande sobreviva al recorrido HTTP → dominio → Prisma → PostgreSQL → HTTP. Con `Decimal(10,2)`, los precios y el monto de entrada compartían ese límite, `orders.size` era INTEGER tanto para acciones como para pesos de transferencias, `Decimal` operaba con precisión 20 por defecto, la salida monetaria pasaba por `number` y las transferencias aplicaban floor a pesos enteros. Esa combinación producía pérdida de un centavo en serialización y redondeo incorrecto al operar por encima de quince dígitos significativos.

Evidencia reproducida, referencias de código y alternativas evaluadas: `docs/references/precision-datos-financieros.md`.

**Objetivo del diseño:** representar, validar, calcular y persistir grandes importes con centavos, sin truncamiento monetario silencioso, sin overflow que termine en un 500 evitable y sin modificar la identidad de los usuarios.

## Alcance

### 1. Decisiones D1–D5

| ID | Decisión | Motivo y costo |
|---|---|---|
| D1 | Dinero almacenado en **NUMERIC(24,2)**; cálculo con constructor Decimal financiero de **64 cifras significativas**. | Máximo por importe/precio: `9999999999999999999999.99`. Es el límite técnico del tipo, no una regla de negocio ni capacidad infinita. |
| D2 | **orders.size** pasa de INTEGER a **NUMERIC(24,2)**; dos unidades físicas según side, separadas en tipos de dominio. Sin columnas ni tablas nuevas. | Es el cambio sobre campos existentes que habilita cash grande y centavos. El campo físico conserva su doble propósito, visible y tipado por lado. Las acciones siguen enteras y acotadas a INT4 por orden. |
| D3 | Dinero de entrada y salida como **strings decimales**; quantity agregada como string entero; size de trading sigue number entero acotado. | Evita pasar importes y cantidades agregadas por number. Es un **cambio incompatible del contrato HTTP vigente**, no una corrección transparente. Porcentajes e IDs no cambian de representación. |
| D4 | Las transferencias nuevas mueven el **monto exacto con centavos**, sin floor. Las órdenes BUY/SELL conservan floor para convertir monto a acciones. | Corrige el cash entero. Cambia la semántica anterior de UC-5 y exige compatibilidad explícita de replays históricos, sin modificar el dinero ya movido. |
| D5 | Migración coordinada con pausa de escrituras y **excepción acotada** para personalizar la migración nueva, aún no aplicada, con CHECKs. | AGENTS.md prohíbe editar migrations a mano y la regla no se elude: la excepción se autoriza y se registra antes de ejecutar. El despliegue no es rolling y la ventana incluye pausa de escrituras. |

Cambiar precisión, representación o política de transferencias exige una decisión nueva; D1–D5 describen el sistema tal como está.

### 2. DB: campos, unidades y garantías

| Campos | Snapshot legacy | Head versionado | Unidad / semántica |
|---|---|---|---|
| orders.price, orders.filledPrice | NUMERIC(10,2) | NUMERIC(24,2) | ARS por acción; en cash se mantiene el precio unitario histórico de 1.00 ARS. NULL se conserva donde corresponde. |
| marketdata.high, low, open, close, previousClose | NUMERIC(10,2) | NUMERIC(24,2) | ARS por acción. Nombres físicos, mapeos y nullabilidad sin cambios. |
| orders.size para BUY/SELL | INTEGER | NUMERIC(24,2), **entero almacenado** | Cantidad de acciones, sin fracciones; por orden 1..2147483647, o 0 en un REJECTED compatible con las reglas existentes. |
| orders.size para CASH_IN/CASH_OUT | INTEGER, pesos | NUMERIC(24,2), pesos | Monto de cash en ARS; para solicitudes nuevas >0, hasta el máximo D1, con centavos. |
| IDs, FKs y secuencias | INTEGER | **Sin cambios** | Sin UUID, sin BIGINT de identificadores, sin regeneración de IDs. |

**CHECKs acotados a los campos financieros modificados**, con el preflight de datos como condición:

- Todo precio no nulo es finito; precio de orden positivo; marketdata no negativo, conservando el caso de precio cero ya contemplado por cálculo/validación.
- size no nulo es finito y no negativo. En BUY/SELL es entero y no supera el máximo de acciones por orden; size 0 sólo es compatible con REJECTED. En cash se permite cero únicamente para los REJECTED históricos de ZERO_SIZE, nunca para una transferencia nueva válida.
- Un NULL financiero ya permitido no se reemplaza por cero. Los campos requeridos para una fila operable se validan en aplicación/mappers; la nullabilidad de tablas legacy se conserva tal cual.
- Sin constraints de email/ticker, sin índices nuevos, sin triggers de estados y sin cambios al mecanismo de idempotencia.
- **Alcance de la garantía:** NUMERIC(24,2) redondea una entrada SQL con escala mayor antes de que un CHECK la vea; Zod la rechaza antes de persistir. Los CHECKs garantizan el valor almacenado; no reconstruyen la precisión de una escritura SQL externa.

La fuente del DDL es el schema Prisma con migraciones versionadas; la migración inicial y los snapshots SQL generados se conservan sin edición.

### 3. Código: representación y aritmética

1. **Una configuración financiera explícita.** Constructor Decimal propio mediante clone, precisión 64 y ROUND_HALF_UP, ubicado en contratos para que dominio e infra lo consuman sin invertir dependencias. La configuración global del paquete no se muta desde el arranque ni depende del orden de imports. Los mappers reconstruyen los decimales por string con este constructor antes de operar.
2. **Una sola definición de rango y gramática monetaria en contratos.** El espejo OpenAPI la reutiliza y no existe una segunda constante independiente de máximo. DB y código se contrastan mediante pruebas de integración, sin que el dominio dependa del cliente Prisma.
3. **Tipos discriminados por side.** BUY/SELL exponen internamente sizeShares entero; CASH_IN/CASH_OUT exponen amountArs Decimal, aunque ambos se mapeen a la columna física size. No hay `number | Decimal` ambiguo usado como acciones en todos los caminos ni `any`. Las proyecciones FILLED de cash devuelven un monto, no acciones ficticias.
4. **Sumas y productos exactos dentro del presupuesto soportado.** El dinero vive en Decimal financiero y las cantidades agregadas/reservas en bigint. Las cantidades por orden son number seguro dentro del rango vigente; la conversión es a Decimal por string y a bigint sólo después de validar que son enteros seguros. Portfolio, reservas, promedio y validaciones de SELL operan así.
5. **Sizing defensivo.** BUY/SELL calcula floor en Decimal y valida 0 y máximo **antes** de convertir a number. Un size derivado por encima de 2147483647 devuelve 400 VALIDATION_ERROR sin ninguna escritura, incluida una orden REJECTED. Un 0 conserva REJECTED ZERO_SIZE. La rama cash no llama al sizing de acciones.
6. **Divisiones y redondeo explícitos.** Promedio y P&L pueden tener expansión periódica: se calculan con precisión 64, sin cuantizar cada paso. El dinero se cuantiza a dos decimales al presentar; los porcentajes conservan su contrato numérico y se convierten sólo en su serializador, con finitud validada. Las divisiones periódicas no son exactas y el diseño no lo afirma.
7. **Precio, notional y saldo son magnitudes distintas.** D1 acota cada precio/monto solicitado y el cash de cada fila; price × size, reservas y totales calculados pueden superarlo sin ser inválidos. El máximo de una columna no se reutiliza como límite del patrimonio y ningún producto se redondea a través de number.

La evidencia calcula 43 cifras para un presupuesto de precio máximo × acciones máximas por orden × máximo positivo INT4 de órdenes. Precisión 64 ofrece margen para esos productos y sumas; cambiar límites de cantidades o IDs exige recalcular el presupuesto. El presupuesto describe cifras significativas; el rendimiento a ese volumen es una medición aparte.

### 4. Contrato HTTP vigente — cambio incompatible y coordinado

- **Entrada monetaria:** string decimal de base 10, hasta 22 dígitos enteros y dos decimales; punto decimal, sin exponente, separadores, signo `+`, espacios ni ceros iniciales salvo el propio 0. Los números JSON se rechazan incluso pequeños: la aplicación no puede recuperar cifras que el parser ya perdió. Price/amount de operaciones válidas son positivos.
- **Salida monetaria:** strings con exactamente dos decimales, sin notación científica ni `-0.00`; NULL donde significa ausencia. Abarca cash, reservedCash, totalAccountValue, marketValue, price, filledPrice y previousClose. El esquema de salida permite resultados agregados mayores al máximo de una fila.
- **OrderResponse.size:** discriminado por side. BUY/SELL: number entero/null según el caso vigente. CASH_IN/CASH_OUT: string monetario — representa pesos, incluida la parte decimal. La respuesta de un cash histórico de size 123 se representa como `"123.00"`, sin cambiar el valor persistido. No hay otro campo monetario duplicado.
- **Portfolio.quantity:** string entero canónico, con signo para la posición negativa heredada. El bigint interno nunca se envía directamente a JSON. Conserva exactitud cuando muchas órdenes válidas acumulan cantidades superiores al entero seguro de JS.
- **Sin nuevas rutas ni versión paralela implícita.** El contrato actual, los clientes/ejemplos/tests y OpenAPI avanzaron juntos con D3. La API no devuelve number/string según el tamaño ni mantiene dos formas monetarias en paralelo.
- Los IDs, size de entrada de BUY/SELL, porcentajes y estados/status de casos de uso no cambian, salvo los rechazos técnicos de rango aquí especificados.

### 5. Cash exacto e idempotencia histórica

- CASH_IN nuevo acredita exactamente amountArs; CASH_OUT compara **ese monto exacto** contra el disponible leído dentro de la transacción. Se persiste en size con precio unitario 1.00 y eventos con montos canónicos en string. Una transferencia de 0.01 es válida, no ZERO_SIZE.
- No se reescriben size, precios ni eventos históricos para recuperar fracciones descartadas. Un CASH_IN histórico pedido por 123.45 pero representado por 123 pesos sigue moviendo 123.00 después de migrar; los 0.45 no se regalan ni se debitan al recalcular.
- Se conservan UNIQUE(userId, idempotencyKey), INSERT ON CONFLICT como primera escritura, lock por usuario y orden+evento en la misma transacción.
- Dos transferencias nuevas con la misma key pero montos 123.01 y 123.99 dan 409, nunca colapsan por floor. `"123.0"` y `"123.00"` son el mismo monto.
- Para una key cash histórica, la comparación incluye el monto original documentado en metadata.amountArs del evento de origen, con validación estricta de esa evidencia. Mismo pedido original: devuelve la fila original, sin evento nuevo y sin reejecutar diferencias de centavos. Distinto: 409. Una key histórica sin evidencia suficiente para establecer el pedido exacto falla conservadoramente con 409; la API no adivina ni vuelve a mover fondos.
- La cobertura de pruebas recorre los casos del replay histórico: key histórica que recibió 123.45 y persistió 123; retry 123.45 devuelve el movimiento original de 123.00; retry 123.99 es conflicto; nueva key por 123.45 persiste 123.45.

### 6. Migración y convivencia

La migración se aplica en una ventana coordinada, con este procedimiento establecido:

1. **Preflight de sólo lectura**, en una copia/test aislado autorizado: inventario de size/precios nulos, cero, negativos, especiales, cash con precio distinto de 1.00 y keys cash sin evidencia de monto original. El informe registra conteos y valores financieros de control, nunca credenciales ni datos personales. Una inconsistencia detiene la aplicación hasta que exista una decisión explícita; el preflight no normaliza por defecto.
2. **La migración nace del schema con create-only**, con el cast INTEGER → NUMERIC y el widening de los siete precios revisados en el diff. La personalización de CHECKs se limita a la migración nueva, aún no aplicada (D5); las migraciones ya aplicadas no se editan.
3. **Validación en DB de test migrada y en un clon con datos representativos:** conservación exacta de valores, IDs, claves y eventos; mismo cash/posiciones/patrimonio del seed por valor, aunque cambie su forma JSON. El seed original carga sin editarse sobre el esquema final.
4. **Despliegue con pausa coordinada de escrituras** y reemplazo de todas las instancias antiguas antes de habilitar cash fraccional o grande. El cliente viejo espera size Int y no es compatible con el nuevo tipo: no hay convivencia rolling.
5. **La ventana se fija con las mediciones de locks y duración del entorno de ensayo**, y con backup y plan de restauración listos antes de ejecutar.
6. **Rollback:** antes de aceptar datos nuevos se restaura el estado ensayado; después de almacenar fracciones o importes fuera del rango anterior no hay downgrade por cast/truncado — requiere restauración o reconciliación aprobada, con su costo y su indisponibilidad explícitos.

## Restricciones

- Alcance cerrado a capacidad monetaria y consistencia de representación/persistencia; quedan fuera auth, UUID, logs, Docker, fuentes nuevas de precios, matching continuo y optimizaciones generales de consultas.
- Sin tablas ni columnas nuevas, sin saldos materializados, sin cambio de unidad a centavos almacenados, sin dinero en float y sin dependencias nuevas: D1–D3 se sostienen con el esquema existente.
- La historia del modelo no se reescribe con defaults silenciosos: los campos financieros y eventos anteriores conservan sus valores, y el cash no se mezcla con cantidades en los cálculos nuevos.
- SQL parametrizado y las garantías transaccionales/idempotentes existentes se mantienen. Una falla en el evento revierte el movimiento completo.
- AGENTS.md, DECISIONS.md, el contrato HTTP, el schema y los tests avanzaron junto con D1–D5; esta spec los referencia, no los reemplaza.
- Los CHECKs nuevos nacen en una migración revisada; su SQL no vive en un script de arranque y no hay ningún CHECK declarado fuera del head versionado.

## Implementación por componente

| Componente | Estado en el código |
|---|---|
| Contratos | `src/contracts/financial-decimal.ts` aísla el constructor de 64 cifras; `src/contracts/money.ts` define gramática y máximo una sola vez y serializa a dos decimales; `src/contracts/domain.ts` expone las uniones discriminadas por side. |
| Sizing | `src/domain/sizing/index.ts` calcula en Decimal y valida el rango INT4 antes de `number`. |
| Dominio de portfolio | `src/domain/portfolio/index.ts` deriva cash exacto, reservas y cantidades agregadas en bigint. |
| Aplicación | `src/application/orders/submit-order.ts`, `decide-order.ts`, `persist-order-decision.ts` y `src/application/transfers/submit-transfer.ts` deciden y persisten por el mismo camino transaccional. |
| Infraestructura | `src/infra/prisma/mappers.ts` y `order-repository.ts` leen y escriben size discriminado, con claim idempotente y replay histórico. |
| Borde HTTP | `src/http/shared/edge.ts` serializa size de cash como string monetario y de trading como entero; el router de portfolio emite quantity canónica. |
| Contrato publicado | `scripts/openapi/wire.ts` reutiliza el schema monetario de contratos y `openapi.json` refleja gramática, límites y ejemplos. |
| Documentación | `docs/CODEMAP.md`, `docs/database.md` y `docs/api.md` describen tipos, unidades, límites y el procedimiento de despliegue. |

## Comportamiento verificado

1. El precio/monto máximo D1 persiste y vuelve con sus centavos; máximo+0.01 y una entrada con más escala se rechazan en la API sin filas ni eventos nuevos.
2. `90071992547409.93` se conserva sin convertirse en `90071992547409.94`; restar 0.01 al máximo da exactamente `9999999999999999999999.98`.
3. Una transferencia nueva de 0.01 y otra de 123.45 mueven exactamente esos importes; un CASH_OUT por un centavo sobre el disponible se rechaza sin debitar.
4. Dos escrituras concurrentes con fondos que alcanzan para una sola no gastan dos veces; auditoría y replays siguen la misma disciplina transaccional.
5. Una cantidad derivada de BUY/SELL fuera de rango devuelve 400 sin INSERT; las acciones fraccionarias no se almacenan como trading válido.
6. Cash, reservas y totalAccountValue pueden superar el máximo de una fila por agregación y siguen exactos; la quantity agregada puede superar el entero seguro de JS sin contaminar marketValue.
7. El seed conserva sus valores financieros e IDs y no se acreditan centavos históricos faltantes. Los replays históricos de §5 no reejecutan movimientos.
8. La migración se valida desde el esquema viejo con datos y desde una DB nueva con el seed intacto. Los CHECKs se inspeccionan en PostgreSQL, no en mocks; el rollback de una multi-escritura está probado.
9. OpenAPI, ejemplos y consumidores de las suites usan el contrato vigente, sin tipos de salida monetarios dependientes del tamaño.
10. Las verificaciones corren con salida real: typecheck, lint y las suites de integración contra PostgreSQL de test.

## Decisiones vigentes

- [x] D1 — NUMERIC(24,2) y presupuesto Decimal 64.
- [x] D2 — size NUMERIC, acciones INT4 por orden y cash/trading separados en tipos.
- [x] D3 — Cambio incompatible: dinero string, quantity agregada string y size de cash string; sin endpoint paralelo.
- [x] D4 — Transferencias nuevas exactas con centavos y política conservadora para keys históricas.
- [x] D5 — Migración coordinada y permiso puntual para personalizar sólo la migración nueva aún no aplicada.
