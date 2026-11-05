# Evidencia — capacidad y precisión de datos financieros

> Investigación de apoyo, no diseño aprobado. La propuesta y sus decisiones pendientes viven en `specs/datos-financieros-grandes-montos.md`. No habilita implementación ni migraciones.

## 1. Estado observado

Base de revisión: `main` en `60b3764a0be0c13bc85e65be383176e251d0a92d`, con cambios locales preexistentes. No se conectó a PostgreSQL.

| Camino | Evidencia local | Consecuencia |
|---|---|---|
| Precios | `prisma/schema.prisma:107–111,126,140`: siete campos Decimal(10,2) | Límite actual de ocho dígitos enteros y dos decimales por campo. |
| Cantidad / cash | `prisma/schema.prisma:125`: size Int; `src/application/transfers/submit-transfer.ts:126–131` usa floor(amount/1) | La misma columna representa acciones o pesos enteros. Ampliar sólo los precios no amplía el cash de una transferencia ni conserva su fracción. |
| Entrada | `src/contracts/money.ts:76–94` y `scripts/openapi/wire.ts:28–46` | El máximo está repetido en runtime y espejo OpenAPI. |
| Salida | `src/contracts/money.ts:103–107` convierte Decimal a Number | Cuantizar antes de convertir no garantiza preservar centavos de valores grandes. |
| Cálculo | `src/domain/portfolio/index.ts:95–105,124–133`; constructor Decimal sin configuración financiera propia | La precisión y las acumulaciones de cantidades también limitan el resultado. |
| Sizing | `src/domain/sizing/index.ts:20–23` y `src/application/orders/decide-order.ts:98–102` | Se convierte a number antes de validar la cota del tamaño derivado. |

## 2. Ejecución aislada reproducible

Comando ejecutado desde el repositorio:

```text
node --import tsx /home/cofi/.hermes/profiles/cocos-backend/cache/scratch/large-money-spec-evidence.mjs
```

Resultados reales, sin DB ni cambios al código de aplicación:

```text
Decimal.precision actual: 20
serializeMoneyArs("90071992547409.93") -> número cuya representación es 90071992547409.94

Máximo calculado de NUMERIC(24,2): 9999999999999999999999.99
Restar 0.01 con la precisión actual -> 10000000000000000000000.00
Restar 0.01 con un constructor aislado de precisión 64 -> 9999999999999999999999.98

Regla de sizing usada actualmente por cash:
floor(123.45 / 1.00) -> 123
Diferencia respecto del monto pedido -> 0.45
```

El constructor de precisión 64 utilizado en la sonda sólo verifica aritmética de la propuesta; no implementa el cambio en el repo. La diferencia de cash descrita es respecto del pedido: la transferencia actual registra el residuo y no representa que esos centavos hayan sido acreditados.

Presupuesto conservador de cifras de la sonda: máximo propuesto de precio × máximo INT4 de acciones × máximo INT4 positivo de órdenes da `46116860141324206089999953883139858675793.91`, con 43 cifras contando los dos decimales. Esto fundamenta margen para sumas/productos con precisión 64 bajo esos límites; no prueba exactitud de divisiones periódicas, duración aceptable de millones de filas ni capacidad ilimitada.

## 3. Alternativas analizadas — evidencia, no alcance adicional

| Alternativa | Ventaja | Costo / límite |
|---|---|---|
| Sólo ampliar price/filledPrice/OHLC | Diff pequeño de schema | No resuelve size de cash, precisión de Decimal ni serialización. Insuficiente como solución end-to-end. |
| size BIGINT | Conserva acciones enteras y amplía pesos enteros | BigInt en Prisma/JS y JSON requieren tratamiento explícito; por sí solo no almacena centavos en cash. No migrar a esta alternativa sin pedido/decisión. |
| Nueva columna exclusiva de monto cash | Separa unidades en almacenamiento | Introduce campo, backfill, compatibilidad y reglas de coexistencia. Es una opción futura si se prefiere normalizar el modelo; no se promueve a requisito. |
| size NUMERIC y tipos discriminados por side en código | Amplía el campo existente sin columnas nuevas y conserva la unidad histórica de pesos para cash | La columna sigue teniendo dos unidades según side; exige validación de enteros para trading y no puede mapearse indiscriminadamente a number. |
| Centavos enteros para todo | Otra representación exacta válida | Cambia unidad, migración, seed y puertos; no es necesaria si se mantiene Decimal coherentemente. Fuera de la propuesta. |
| NUMERIC sin precisión ni escala declaradas | Más rango y flexibilidad | Requiere constraints explícitas de rango/escala y un dominio acotado en aplicación; no ofrece capacidad infinita práctica. No es la opción propuesta. |

No se considera UUID una solución a capacidad monetaria ni a autorización. No se propone migrar identificadores.

## 4. Límites reales de la DB y de la migración

- NUMERIC(p,s) limita las cifras a la izquierda a p−s. Al asignar un dato con escala mayor, PostgreSQL lo redondea a la escala de la columna antes de comprobar el rango. Por ello un CHECK sobre la columna ya convertida no permite reconstruir ni rechazar toda precisión extra del texto original.
- NUMERIC admite NaN. Para dinero, un CHECK sólo de positividad no expresa finitud suficiente; las pruebas de constraints deben incluir NaN y los valores especiales pertinentes.
- Aumentar precisión/cambiar el tipo de size puede tomar locks y reescribir datos. No se promete migración online ni rollback sin pérdida después de incorporar importes fuera del rango viejo.
- No hay evidencias de SQL injection en el patrón actual de tagged templates. La ampliación de tipos no justifica reemplazarlo por concatenación.
- Los CHECKs y SQL de datos personalizados requieren un vehículo de migración revisado. El flujo oficial de Prisma permite personalizar una migración aún no aplicada, pero `AGENTS.md` prohíbe editar migrations a mano. La spec pide autorización puntual; no asume una excepción.

## 5. Fuentes primarias consultadas

La extracción directa de páginas no estuvo disponible en el backend configurado. Se consultaron resultados de búsqueda restringidos a documentación primaria y se contrastaron los puntos aritméticos con el paquete instalado. No se tomó una versión nueva de Prisma como base del proyecto ni se instaló nada.

- **PostgreSQL 18 — Numeric Types**: precisión, escala, redondeo y valores especiales.
  Dirección: `https://www.postgresql.org/docs/18/datatype-numeric.html`
- **decimal.js — API**: precisión por defecto, redondeo y constructores independientes mediante clone.
  Dirección: `https://mikemcl.github.io/decimal.js/`
- **Prisma — Include unsupported database features**: migración nueva con create-only y personalización antes de aplicar. Debe verificarse el soporte concreto del CLI 7 instalado antes de ejecutar; la documentación no reemplaza las reglas del repo.
  Dirección: `https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features`

Esta evidencia no cambia la salida HTTP vigente, el seed, la configuración de DB ni las reglas firmadas de dominio.
