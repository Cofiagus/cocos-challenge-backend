# Evidencia — capacidad y precisión de datos financieros

> Fundamento de las decisiones D1–D5 de `specs/datos-financieros-grandes-montos.md` y de
> `DECISIONS.md`: los límites que el diseño evita, la aritmética que lo sostiene y el alcance real
> de cada garantía.

## 1. Los límites que el diseño evita

| Camino | Configuración anterior | Consecuencia |
|---|---|---|
| Precios | siete campos `Decimal(10,2)` | ocho dígitos enteros y dos decimales por campo |
| Cantidad / cash | `size Int`; la transferencia usa `floor(amount / 1)` | la misma columna representa acciones o pesos enteros; ampliar sólo los precios no conserva la fracción del cash |
| Entrada | máximo repetido en runtime y en el espejo OpenAPI | dos fuentes del mismo límite |
| Salida | `Decimal` convertido a `Number` | cuantizar antes de convertir no preserva centavos de valores grandes |
| Cálculo | constructor `Decimal` sin configuración financiera propia | precisión y acumulación de cantidades limitan el resultado |
| Sizing | conversión a `number` antes de validar la cota | el rango derivado se comprueba tarde |

Los seis límites recorren el camino completo HTTP → dominio → Prisma → PostgreSQL → HTTP: por eso
D1–D5 cubren tipos, aritmética, contrato y sizing en conjunto y no sólo las columnas de precios.

## 2. Aritmética reproducida

Los cálculos se reproducen con el paquete `decimal.js` del proyecto, sin DB:

```text
Decimal.precision por defecto: 20
serializeMoneyArs("90071992547409.93") -> número cuya representación es 90071992547409.94

Máximo de NUMERIC(24,2): 9999999999999999999999.99
Restar 0.01 con precisión 20 -> 10000000000000000000000.00
Restar 0.01 con el constructor aislado de precisión 64 -> 9999999999999999999999.98

Regla de sizing de cash sin centavos:
floor(123.45 / 1.00) -> 123
Diferencia respecto del monto pedido -> 0.45
```

La primera y la tercera línea son la razón de D1; la cuarta, la de D4: el constructor de 64 cifras
conserva el centavo en el máximo y el cash nuevo mueve el monto exacto en lugar del floor.

Presupuesto de cifras: precio máximo × máximo INT4 de acciones × máximo INT4 positivo de órdenes da
`46116860141324206089999953883139858675793.91`, 43 cifras contando los dos decimales. Precisión 64
cubre esos productos y sumas con margen. El presupuesto es de cifras significativas: las divisiones
periódicas no son exactas y el rendimiento a millones de filas es una medición aparte.

## 3. Alternativas evaluadas

| Alternativa | Ventaja | Por qué no se adopta |
|---|---|---|
| Sólo ampliar price/filledPrice/OHLC | diff pequeño de schema | no resuelve size de cash, precisión de Decimal ni serialización: no cubre el recorrido completo |
| size BIGINT | conserva acciones enteras y amplía pesos enteros | BigInt en Prisma/JS y en JSON exige tratamiento explícito y no almacena centavos en cash |
| Nueva columna exclusiva de monto cash | separa unidades en almacenamiento | introduce campo, backfill, compatibilidad y reglas de coexistencia; el esquema existente no necesita una columna nueva |
| size NUMERIC con tipos discriminados por side | amplía el campo existente sin columnas nuevas y conserva la unidad histórica de pesos | es la decisión D2: la columna mantiene dos unidades, con validación de enteros para trading y sin mapeo indiscriminado a `number` |
| Centavos enteros para todo | otra representación exacta válida | cambia unidad, migración, seed y puertos sin necesidad: el Decimal financiero ya es exacto en el rango declarado |
| NUMERIC sin precisión ni escala | más rango y flexibilidad | exige constraints explícitas de rango/escala y un dominio acotado en aplicación, sin capacidad infinita práctica |

Los identificadores no son una palanca de capacidad monetaria ni de autorización: IDs, FKs y
secuencias siguen en INTEGER.

## 4. Límites de la DB y de la migración

- NUMERIC(p,s) limita las cifras a la izquierda a p−s. PostgreSQL redondea a la escala de la columna
  antes de comprobar el rango, así que un CHECK sobre la columna convertida no reconstruye la
  precisión del texto original. El borde Zod rechaza la escala extra antes de persistir y el CHECK
  garantiza el valor almacenado.
- NUMERIC admite NaN. Para dinero, un CHECK de positividad no expresa finitud suficiente: las
  pruebas de constraints incluyen NaN y los valores especiales pertinentes.
- Ampliar precisión o cambiar el tipo de size toma locks y reescribe datos. La migración es
  coordinada y con pausa de escrituras; no es online, y después de incorporar importes fuera del
  rango anterior no hay rollback por cast.
- El patrón actual de tagged templates parametriza el SQL; la ampliación de tipos no justifica
  reemplazarlo por concatenación.
- Los CHECKs viven en una migración revisada. El flujo oficial de Prisma permite personalizar una
  migración aún no aplicada y AGENTS.md prohíbe editar migrations a mano: la excepción de D5 se
  autoriza y se registra antes de ejecutar.

## 5. Fuentes primarias consultadas

- **PostgreSQL 18 — Numeric Types**: precisión, escala, redondeo y valores especiales.
  Dirección: `https://www.postgresql.org/docs/18/datatype-numeric.html`
- **decimal.js — API**: precisión por defecto, redondeo y constructores independientes mediante clone.
  Dirección: `https://mikemcl.github.io/decimal.js/`
- **Prisma — Include unsupported database features**: migración nueva con create-only y
  personalización antes de aplicar.
  Dirección: `https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features`

El contraste aritmético se hizo con el paquete instalado y la versión de Prisma del proyecto no
cambia por esta decisión. El contrato HTTP, el seed, la configuración de DB y las reglas de dominio
están descritos en `specs/` y `docs/`; esta nota es su fundamento.
