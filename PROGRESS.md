# PROGRESS.md — ejecución por células

## Activo — ROLLOUT LOCAL CERRADO: G0–G5 verdes, main integrado y limpio, API viva en loopback

**Corte 2026-11-05 20:45 (-03):** el usuario pidió handoff para seguir las pruebas en otra sesión. No continuar pruebas, migraciones, runtime ni diagrama por notificaciones tardías. Punto de entrada: `docs/references/handoff-local-rollout.md`. Interrupción confirmada de la única célula activa; sus borradores coinciden byte a byte con el snapshot privado y no fueron integrados ni certificados.

- Firma humana 2026-11-05: «SI APRUEBO» al plan Rev. 3 y sus cuatro puntos. Fuente inmutable: `specs/integracion-instrumentos-despliegue-local.md`; firma registrada en `e967050`, ya integrado en main.
- Base financiera preservada: `8d1475f`; UC-2 origen `4541d1c`, ancestro común `60b3764`. Revisión integrada en main: `63e65ac`; el commit que cierra G2 incorpora este registro y el merge (SHA final en `git log -1`). Snapshots recuperables: `backup/pre-instruments-rollout-20261105` y `backup/pre-uc2-main-integration-20261105` (`1ef6549`). No se ejecutó la migración de la DB app.
- Gate documental de main repetido tras las actualizaciones de este registro: typecheck + lint + 2 suites / 15 tests docs + diff-check verdes. Integrador y seams preparados inicialmente con dependencias offline y Prisma Client 7.10.1 propios: ambos typecheck/lint + 6 suites / 71 tests verdes.
- Baseline completo repetido por el supervisor sobre main `266d85d`: **37 suites / 515 tests**, `openHandles=[]`, contra PostgreSQL real en 55432. La primera corrida dio 64 fallos de setup porque la DB base nueva no existía; se creó/migró/cargó exclusivamente `cocos_rollout_supervisor_test` con el script versionado y la repetición pasó completa, sin cambios de código. Evidencia privada: `run-logs/instruments-rollout-20261105/main-baseline-prepared-jest.json` del perfil.
- Revisión `63e65ac` aceptada por QA final independiente **9.5/10** e integrada localmente en main (`bd60d65`). G1/G2 cerrados: generate/typecheck/lint/build/OpenAPI verdes, núcleo financiero congelado idéntico a `8d1475f`; **42 suites / 581 tests / 118 funcionales / 19 aceptación grandes montos / 0 pendientes/todo / openHandles=[]** en candidata, QA y main. G0 cerrado tras autorización nueva explícita y lectura del supervisor; no se ejecutó migración app, runtime ni Yahoo live. Pedido actual: mostrar antes/después del esquema sin confundir el objetivo validado en test con aplicación sobre app.
- Topología aprobada: app PostgreSQL local 5433 / `cocos_challenge`; API loopback 3000; DBs de test aisladas en 55432. Seed sólo en DB app recién creada, nunca en una preexistente. El entorno heredado `lm_prepare_test` NO es destino runtime.

- **Reanudación 2026-11-06 (sesión nueva; leídos este archivo, el handoff y `git log`)**: el humano confirmó «sí, arrancar» la Wave 1. Despachadas en paralelo `DIAGRAM-FINISH` (`sa-0-64a04488`, GLM, rama `docs/db-schema-before-after`) ∥ `A3-MIGRATE` (`sa-1-03094ac2`, GLM, **único operador DB**, worktree principal main `70862f7`). Orden de gates: G3 ⇒ A4 ⇒ A5 ⇒ A6 sólo por fallo reproducido.
- **Grounding medido 2026-11-06 (no asumido)**: main `70862f7` limpio · DB app 5433 `cocos_challenge` con **SOLO** `20261103003419_init_trading_api`, `20261105104903_large_money` pendiente, conteos 4/66/12/1/126 · cluster test 55432 vivo con clon `a0_restore_rehearsal_20261105` · **0 sesiones ajenas** en ambos · 160 G libres. Los dos borradores del diagrama siguen untracked con SHA256 idénticos al snapshot del corte.
- **Hallazgo Yahoo (medido hoy)**: `query1.finance.yahoo.com` responde **429** con UA `curl/*` y **200** con UA de navegador; `query2.finance.yahoo.com` responde **429** aun con UA de navegador. El adaptador (`src/infra/yahoo/yahoo-instrument-quote-source.ts:111`) llama `fetch(url, { signal })` **sin headers** ⇒ no manda UA. Riesgo real de 429 en A5. **Decisión humana: si se confirma 429 ⇒ BLOQUEO declarado y escalar, sin tocar código** (queda explícitamente descartado el fix de UA vía A6).

| Célula / fase | Ownership | Estado | Evidencia / siguiente gate |
|---|---|---|---|
| A0 operador DB (GLM) | Identidad/arranque PG 5433; inventario read-only DB app; backup privado y restore de clon de test | ARRANQUE/BACKUP VERIFICADOS; métrica inicial errónea descartada | Revisor corrigió economía; supervisor verificó G0 tras nueva autorización, backup y snapshot conservados |
| QA-G0 + supervisor | Fórmulas económicas y fingerprints completos; lectura app/clon | G0 CERRADO, ACCEPT | Repetición autorizada 2026-11-05: transacciones REPEATABLE READ READ ONLY, app=clon=snapshot previo, 0 sesiones ajenas, 0 guardas violadas, backup/checksums válidos |
| C-SEAMS (DeepSeek) | Contratos UC-2, error/puerto financiero, offset catálogo y dos unit tests; sólo sus filas CODEMAP | ACEPTADA e integrada en main vía `63e65ac` | QA independiente ACCEPT 9/10; gate parcial 5 suites/64; gate completo en main 42/581 |
| QA-SEAMS (DeepSeek independiente) | Revisión read-only del SHA exacto en worktree propio | DONE, ACCEPT 9/10 (`deleg_d187bcfe`) | 21 unit propios repetidos, matriz completa validada, sin defecto del seam; pendientes de consumidor/docs siguen explícitos |
| C-YAHOO (GLM) | Nuevo adaptador Yahoo + unit test, fila infra CODEMAP | ACEPTADA 8.5/10; integrada en candidata `dd17c1a` | Autor `80fc80a`; padre repitió gate local tras merge, sin conexión Yahoo real ni DB |
| C-UC2 (DeepSeek) | Nuevo caso de uso + router y dos unit tests, filas application/HTTP CODEMAP | ACEPTADA 9/10; integrada en candidata `3767f2f` | Autor `68a1e83`/`ede3f80`; padre repitió lint + 8 suites / 99 unit tests conjuntos |
| QA-YAHOO/UC2 (DeepSeek independiente) | Dos SHAs exactos sucesivos en worktree QA propio, sólo lectura | DONE, ACCEPT 8.5/9 (`deleg_8bff4037`) | Constructor real 64 y Decimal global 20 comprobados con probe inyectado; gap de alias estructural no es bug actual |
| C-WIRING (DeepSeek) | server.ts + soporte large-money y filas CODEMAP de composición | ACEPTADA 9/10 e integrada en candidata `a51ee39` | Padre repitió lint + 99 unit + 19 E2E post-merge; consumidor read pendiente entonces, ya cerrado por C-TESTS |
| QA-WIRING (DeepSeek independiente) | SHA exacto `8287e22`, código sólo lectura + tests aislados | DONE ACCEPT 9/10 (`deleg_5b7f93b5`, task 1) | Repetidos 22 unit + 19 E2E; smoke sin fetch ni conexión app; atribución imprecisa de cobertura corregida por el padre |
| C-DOCS-WIRE (GLM) | registry/OpenAPI generado + docs/api.md UC-2/503 | ACEPTADA 9/10 e integrada en candidata `db7f893` | Padre repitió lint + 15 tests docs y regeneración sin drift después del merge |
| QA-DOCS-WIRE (DeepSeek independiente) | SHA `c64890c`, sólo metadata/API/contrato generado | DONE ACCEPT 9/10 (`deleg_a998abb7`, task 1) | Otros cuatro operations OpenAPI idénticos; 503/400/query/precio disponible correctos; sin DB/red |
| C-DOCS-NARRATIVE (GLM) | README/DECISIONS/legacy + dominio derivado/HTML, sólo UC-2 | ACEPTADA 9.2/10 e integrada en candidata `7a3f90a` | Tres commits de 2/1/2 docs; lint + 15 tests docs tras cada corte; cinco archivos idénticos al snapshot revisado `4d7581c` |
| QA-DOCS-NARRATIVE (DeepSeek independiente) | SHA `4d7581c`, cinco documentos, sólo lectura | DONE ACCEPT 9.2/10 (`deleg_b55db3d6`) | D1–D5 preservadas, semántica UC-2 y wiring correctos; sin seed como precio actual ni claims live; observación histórica no bloqueante registrada |
| C-TESTS (GLM) | read/support.ts + read-endpoints.test.ts; UC-1 intacto | ACEPTADA 9/10 e integrada en candidata `63e65ac` | Comparaciones monetarias FinancialDecimal; padre repitió typecheck/lint/build/OpenAPI y suite completa post-merge |
| QA-C-TESTS (DeepSeek independiente) | SHA `cb2d4c2`, dos archivos read-only y funcionales sobre test 55432 | DONE ACCEPT 9/10 (`deleg_a8de8a04`) | 26 funcionales + 24 unit verdes; 196 líneas UC-1/hash idénticos; aislamiento verificado; opción A aceptada sin caso extra limit=1 |
| A1 / G1 | Candidata integrada + alcance financiero congelado | CERRADO `63e65ac` | Typecheck 0/lint/build y diff cero en núcleo, schema/migraciones y dependencias contra `8d1475f` |
| QA independiente / G2 | SHA `63e65ac`, candidato completo y contratos financieros | DONE ACCEPT 9.5/10; G2 CERRADO (`deleg_110d92c5`) | Padre verificó JSON/log de QA (42/581/0 handles y gates exit0), luego merge local y repetición completa en main; fuentes idénticas al SHA revisado |
| A3 / G3 migración app | Único operador DB sobre main integrado | **CERRADO, G3 VERDE** (`sa-1-03094ac2`) | `migrate deploy` con DATABASE_URL explícita aplicó `20261105104903_large_money` sobre 127.0.0.1:5433/cocos_challenge. History: 2 aplicadas, 0 rolled_back. Los 6 CHECK verificados por nombre Y definición contra el SQL versionado. 8 columnas NUMERIC(24,2). Backup revalidado (sha256 -c manifest OK x4 + pg_restore en clon NUEVO idéntico a preflight.json). Segundo `migrate deploy` ⇒ «No pending migrations to apply». Sin seed/reset. Clon de evidencia: 55432/a3_restore_check_20261106T002348Z |
| A4 / G4 arranque API | DS; worktree principal, SHA integrado | **CERRADO, G4 VERDE** (`sa-0-4701cb3f`, commit `d7663d1`) |
|          |          |          | `.env` EXISTENTE respaldado (sha256 06a5bd3e…) y editado: DATABASE_URL -> 127.0.0.1:5433/cocos_challenge,
|          |          |          | PORT=3000, keys preservadas; sigue SIN trackear (.gitignore:13). Proceso vivo `node dist/index.js`
|          |          |          | PID 142357; el supervisor confirmó bind **127.0.0.1:3000** con `ss` y smoke HTTP 200 con los
|          |          |          | golden de G0 (cash 627500.00 / reserved 125500.00 / TAV 889756.00). Ajuste MÍNIMO en
|          |          |          | `src/index.ts`: `listen(port, "127.0.0.1")` (antes bindeaba 0.0.0.0). SIGTERM cierra el pool
|          |          |          | y reinicia limpio. |
| A5 / G5 HTTP real | DS; listener real + Yahoo en vivo | **CERRADO, G5 VERDE** (`sa-0-e04b8b6d`) |
|          |          |          | UC-1 HTTP 200 con golden exacto (627500.00 / 125500.00 / 889756.00). UC-2 default 10 ítems,
|          |          |          | `?query=banco` 4 ítems, `?limit=100` 61 ítems. Integridad DB app: conteos idénticos
|          |          |          | antes/después (4/66/12/1/126), 0 rolled_back, **ninguna escritura por HTTP**. |
|          |          |          | Yahoo EN VIVO sin fixtures por el camino real de código: **61/65 acciones = 93.8%**;
|          |          |          | DYCA/PGR/IRCP/MTR = 404 “symbol not found” (no es falla del proveedor). |

| A6 fixes | DS, dueño del archivo | SÓLO si hay fallo reproducido | Sin scope propio hasta que A5 lo requiera |
| DIAGRAM-FINISH (GLM) | docs/references/db-schema-before-after.{html,md} | **INTEGRADO EN MAIN** (`b99a68c` → merge `5645896`) |
|          |          |          | QA independiente **ACCEPT 9/10** (`sa-1-1056c3fc`) con matriz claim→fuente completa: 5 tablas y 4 FK
|          |          |          | correctas, los 8 cambios de tipo, los 6 CHECK por nombre Y definición contra migration.sql, sin
|          |          |          | cambios estructurales (NOT NULL 9 / PK 5 / FK 4 / enums 6 / índices 10 idénticos), cardinalidades
|          |          |          | correctas, honestidad semántica y sin artefactos inventados. Observación cosmética pendiente: una
|          |          |          | etiqueta SVG dice “N” en vez de “1..N”. |

### Decisiones y paradas vigentes

- Aprobadas las limitaciones del parseo JSON numérico externo de Yahoo y timeout de 5 s por cotización secuencial; toda operación monetaria interna sigue `FinancialDecimal` de 64 cifras y wire monetario string.
- Máximo cuatro células activas, worktree por célula de código y DB de test por suite. Un solo administrador de la DB app; los tests sí escriben en sus DBs aisladas.
- Anomalía financiera, legacy sin history, writer desconocido o cambio de contrato/deps/migración no previsto → detener esa parte y volver al humano. No baseline automática, normalización silenciosa, reset app, push ni PR por iniciativa propia.
- Autorización operativa G0 RESUELTA: el usuario dijo «bueno te autorizo a hacerlo pero tambien construi o mostrame un diagrama del esquema antes y despues de los cambios en la db». Se ejecutó el readback sólo después de esa autorización nueva, sin eludir el bloqueo previo. El SQL auditado sigue idéntico y es REPEATABLE READ READ ONLY. Este control no aplicó migraciones ni escribió datos; el diagrama debe indicar que el después viene del esquema test, no de una app ya migrada.
- Decisiones de A0: se acepta arranque del cluster existente y backup/restore privados; se rechaza la supuesta evolución de posiciones del informe, basada en sumas sin filtro FILLED ni signo de cash. SELECTs correctos del padre verifican cash liquidado user 1 `753000.00`, user 2 `123.00`; posiciones liquidadas user 1: BMA `-10`, PAMP `40`, METR `500`. No hubo mutación de datos: el defecto era del cálculo de evidencia. G0 no se cierra sin QA económica y hashes completos comparables.
- DB app ya existe, con 12 órdenes y la migración inicial aplicada cuyo checksum coincide con el archivo versionado. **No se hará seed**. La migración de grandes montos sigue pendiente; el backup privado tiene permisos 700/600 y manifest verificado. El clon `a0_restore_rehearsal_20261105` en 55432 se conserva para comparación.
- C-SEAMS: se aceptan adaptación a FinancialDecimal y wire string, tests negativos adicionales que refuerzan D3 y offset sólo interno. Router/server/large-money/read ya cerrados por sus owners; el último TS2353 desaparece en `63e65ac`, medido por el padre. Docs/OpenAPI verdes desde `db7f893`. Cuatro commits atómicos de seams: `4ad4659`, `c51c809`, `dff54a1`, `56773b2`; CODEMAP asociado al código.
- QA-G0 entregó SQL auditado y JSON privados; el supervisor ahora repitió y verificó app==clon==snapshot previo, con guardas sin violaciones y registry inicial consistente. Evidencia nueva: `run-logs/instruments-rollout-20261105/g0-supervisor-20261105T233941Z/summary.json`, catálogos `schema-before.actual-app.json` y `schema-after.validated-test.json`. La primera comparación contra el archivo histórico detectó encabezados del formato psql alineado, no cambios de datos: se corrigió sólo el parser para admitir marcadores explícitos; SQL y datos intactos. Comparación nueva: 297 marcadores de datos/DDL y G0TX comprobado por separado, por eso el digest nuevo no es el formato histórico de 298. No se aplicó migración app.
- QA-SEAMS aceptada: mensaje con proveedor literal y coerción de `limit=2.0` a entero cumplen lo firmado, no requieren cambios. Los pendientes del router y docs son de fases posteriores, no defectos del seam ni permiso para entregar la feature global roja. La candidata incorpora main hasta `afcc135`; comparación de fuentes/tests/docs contra `56773b2` exacta y gate local post-merge 64/64 verde.
- Implementaciones Yahoo/UC2 aceptadas e integradas secuencialmente tras QA: el constructor real se confirmó en runtime; se rechaza la explicación del autor de que Decimal base no tiparía (alias estructural). No se agrega brand nominal ni hardening fuera de alcance: la implementación actual es correcta y hay controles runtime. Casos extra de símbolo/campos y variantes de query son gaps no bloqueantes, no bugs reproducidos ni razón para perseguir 10/10. Probes fueron inyectados, no prueban conexión Yahoo real.
- C-DOCS-WIRE: se acepta quitar el ejemplo 200 con precios del seed (no hay captura Yahoo live) y el mensaje 400 real para limit=101. Se devuelven dos frases: query ausente/vacía es válida, pero repetida/formato no-string sí puede ser 400; último dato de sesión disponible no garantiza frescura instantánea ni edad máxima. No son cambios de código ni nueva política de recencia. La atribución de cobertura 'funcionales de wiring' en la fila Yahoo del CODEMAP también debe distinguirse del fake de aceptación y del smoke manual, sin inventar una suite.
- C-DOCS-NARRATIVE: devuelta por rótulo HTML heredado 'dinero como número' (contradice D3), cableado en código marcado pendiente cuando `8287e22` ya lo implementa, y ejemplo UC-2 de seed que se omitirá por honestidad. A4/A5/runtime/live siguen pendientes. La precisión de la spec derivada no debe sugerir matching activo. No cambia el diseño ni código financiero. El commit original tocó cinco docs: no se reescribe su historia; el padre integrará el diff final revisado en cortes de máximo dos archivos, preservando el snapshot del autor.
- Candidata `8e2052f`: el padre corrigió sólo la celda de tests Yahoo del CODEMAP para citar la suite unit real; los 19 E2E inyectan fake y no prueban el proveedor. Se rechaza esa atribución del reporte QA sin rechazar el wiring correcto. Lint y D1/D2/D3 de docs verdes; D4 aún falla por API.md viejo en candidata, resuelto en la rama C-DOCS-WIRE que espera QA. El diff de fuentes/tests/scripts/prisma frente a `a51ee39` es vacío: corrección sólo documental.
- C-DOCS-NARRATIVE corregida: se aceptan nota sin valores de cotización, referencia al wiring `8287e22` ya confirmado ACCEPT9/10 y separación explícita de A4/A5 pendientes. La QUESTION del autor sobre si wiring está hecho queda resuelta afirmativamente. QA semántica ACCEPT9.2/10 y port exacto completados en `ae3d1a6`, `ea4cee8`, `7a3f90a`, sin reescribir historia. Se conserva como limitación documental heredada que Tasks de la spec derivada mantiene marcas de T4/T6 (ingesta/seed/API viva) sin rótulo histórico local: no son evidencia de ejecución actual ni autorización para implementar esa ingesta. Las Constraints delimitan el diseño objetivo; el estado vigente es esta sección de PROGRESS. No se persigue 10/10 ampliando el alcance. La observación D4/D5 de la base QA quedó cerrada al integrar metadata `db7f893`: docs 15/15; el TS2353 intermedio quedó cerrado por C-TESTS en `63e65ac`.
- C-TESTS: el padre recalculó contra Git los 196 renglones del bloque UC-1: byte-idénticos entre `8e2052f` y `e820ef0`, SHA256 `e13236c47d6d478ff6bce8922cf5b2993dd56a78e8819f54da3e1f773d8842ae`; QA independiente repitió ese hash hasta `cb2d4c2`. Los 26 tests son 7 UC-1 + 19 UC-2 (fuente fake explícita, HTTP+Prisma reales). `cb2d4c2` reemplaza exclusivamente dos comparaciones Number(money) por FinancialDecimal, sin tocar comportamiento ni UC-1. ACCEPT9/10: se elige A (no sumar limit=1 sólo por completar cobertura; no hay defecto). Mensaje 503 funcional autorreferencial es limitación no bloqueante: los contratos unit verifican el literal. El test funcional de query duplicada cierra la observación de cobertura del revisor metadata.
- G1/G2 cerrados sobre `63e65ac`: base aislada de candidata, base QA `cocos_rollout_g2_qa_test` y base main `cocos_rollout_main_gate_test`, todas sólo en 55432 y corridas secuenciales sin compartir resets. Generate/typecheck/lint/build/OpenAPI determinista y 42 suites/581 tests verdes en las tres ejecuciones, 0 pendientes/todo, `openHandles=[]`. Padre leyó JSON y log de gates QA (PGEN/TSC/LINT/BUILD/OA1/OA2/OADIFF=0) y recalculó el resumen de main. Evidencia privada en `run-logs/instruments-rollout-20261105/`: `candidate-63e65ac-jest.{json,log}`, `g2-qa-63e65ac-jest.{json,log}`, `g2-qa-63e65ac-gates.log`, `main-63e65ac-jest.{json,log}`. Fuentes/tests/config/docs de main idénticos al candidato salvo este PROGRESS; .env/.env.test ignorados e idénticos antes/después del merge por SHA256. No hay push. Esto no cierra G0 ni valida DB app/API/Yahoo live.
- QA final: se elige opción A sobre el mensaje 503 funcional autorreferencial (gap ya registrado, literal cubierto en unit). No se amplía alcance por preferencia. Los 19 casos de aceptación de grandes montos no buscan instrumentos; su fake noQuotes no prueba Yahoo ni debilita esos escenarios financieros.
- **Limpieza de worktrees autorizada por el humano 2026-11-06** con alcance completo: (1) remover los 30 checkouts integrados conservando las refs de rama, (2) conservar `eslint.quality.config.js` antes de borrar su worktree, (3) además borrar las refs de las ramas ya mergeadas, y (4) además remover las 13 ramas no mergeadas (su contenido ya fue portado a main). Ejecutado: **46 → 2** worktrees. Se conservan `cocos-challenge-backend` (main) y `coccb-wt-local-rollout-docs-narrative`, porque sus dos borradores aún no están integrados: se removerá tras el merge de los documentos. 44 removidos = 22 mergeados+limpios sin `--force`, 8 detached en main con sólo `node_modules` untracked, y 14 worktrees de ramas no mergeadas. Refs preservadas en `refs/backup-wtcleanup/*`; snapshot durable en `backups/worktree-cleanup-20261106T002126Z/` del perfil (incluye el `eslint.quality.config.js` rescatado de `coccb-wt-gate`). 16 G liberados.
- **Nueva parada vigente (Yahoo)**: un 429/5xx del proveedor NO puede reportarse como integración exitosa. Si A5 no obtiene precio real ⇒ **BLOQUEO declarado** y vuelta al humano. No se autoriza ningún cambio de código para «arreglar» el proveedor (ni headers, ni reintentos, ni caché) sin pedido explícito.

- **Adjudicación de la discrepancia de datos de control de A3 (léela antes de reutilizar fingerprints)**: el `fingerprint.sql` que A3 heredó del preflight A0 calcula `cash_per_user = sum(size)` **crudo**, sin filtro de `status` ni signo de `side` ⇒ 1100000.00. Ese es exactamente el cálculo que el veredicto de G0 ya había **rechazado como métrica errónea**. La económica canónica es `cashSettledArs`: **753000.00 (user 1)** y 123.00 (user 2), con `cashReservedNewBuyArs` 125500.00 y `cashAvailableArs` 627500.00. El supervisor re-verificó por su cuenta ejecutando las secciones **08 (economía por usuario)** y **09 (fingerprints canónicos)** del SQL auditado de G0 contra el clon del backup (PRE) y la app (POST): **salidas idénticas** (diff vacío). Conclusión: el deploy no alteró datos — el defecto es de la *métrica* del fingerprint, no de la migración. **Lección: no reutilizar el inventario A0 como fingerprint económico sin filtrar FILLED y aplicar signo de side.**
- **Verificación propia del diagrama (supervisor)**: commit `b99a68c` presente sobre `bd60d65`, árbol limpio; 0 colores hex residuales; gate re-corrido por el padre: `npm run typecheck` exit 0, `npm run lint` exit 0, `npx jest tests/docs` ⇒ 2 suites / 15 tests verdes. Corrección del informe del padre: los 12 hex NO eran colores sueltos sino *fallbacks* de `var(--x, #hex)` ya existentes; la célula eliminó los fallbacks, no los colores. **Resultado: QA independiente ACCEPT 9/10 ⇒ merge habilitado.**

---

## Histórico inmediato — grandes montos: DONE — integrado y verificado en main (firma humana 2026-11-05)

- Spec inmutable: `specs/datos-financieros-grandes-montos.md` Rev. 2; D1–D5 aprobadas.
- Rama integradora: `feature/large-money`; worktree `/home/cofi/repos/coccb-wt-large-money`.
- Snapshot base: `b8006afbaaf8e8af3bfc7cf76a63bb557ae6f502` (`snapshot/large-money-20261105`), creado con índice Git alternativo. HEAD y staging originales de main se conservaron; sólo se registró la firma en la spec del árbol original.
- Gate base medido sobre ese commit: **33 suites / 352 tests**, typecheck y lint verdes. PostgreSQL 18.6 nuevo, sólo loopback y puerto 55432, en scratch del perfil; ninguna conexión a DB de app.
- El worktree original contiene trabajo previo del usuario que forma parte del snapshot, no del diff de esta feature. Preservar árbol e índice. El usuario autorizó posteriormente integrar a main tras terminar la implementación, revisión independiente y pruebas completas verdes; no autorizó migrar la DB de la app.
- Integración local realizada por fast-forward en 24bca18. Gate completo repetido desde main: cliente Prisma regenerado, typecheck/lint/build/OpenAPI determinista verdes y 37 suites / 515 tests con PostgreSQL real, sin open handles; revisión independiente final ACCEPT9.0/10. No se hizo push ni se migró la DB de la app.
- Main quedó limpio tras integrar. Los cambios previos ya incorporados en snapshot se preservaron además en stash58d23a8 y backup/main-pre-large-money-60b3764; no se hizo stash pop. Las copias locales de .env y .env.test permanecen byte a byte intactas e ignoradas. Respaldo privado durable: /home/cofi/.hermes/profiles/cocos-backend/backups/large-money-main-integration-60b3764 (33 archivos verificados, permisos privados; contiene índice y patches originales).

| Célula | Alcance / ownership | Estado | Gate |
|---|---|---|---|
| LM-A | Constructor/contratos de dinero y tests monetarios; CODEMAP sólo sus filas | ACEPTADA e integrada hasta 1099fb4 | typecheck/lint/build + 48 tests re-corridos en integradora |
| LM-B | Schema, migración nueva y pruebas PG de almacenamiento/preflight | INTEGRADA: 2bfcf26/e659a09 | 22 tests PG y CHECK NULL re-corridos; cliente nuevo generado |
| LM-C0 | Tipos discriminados y schemas quantity/size | INTEGRADA: 8d1930c/c665109 | contratos y consumidores ya verificados en gate final de feature |
| LM-C1-pure | Dominio puro y ports; cell/large-money-pure-final | INTEGRADA: 3938ec0 | 64 unit/domain re-corridos; sizing RangeError antes de convertir; lint verde |
| LM-C1-app | Casos de uso, HTTP y fakes unitarios; cell/large-money-app-final | INTEGRADA desde 835699a en este merge | 137 unit application/HTTP re-corridos; typecheck global recuperado |
| LM-D-final | Mappers, repos e idempotencia histórica; cell/large-money-infra-final | INTEGRADA desde 86dcbb4 en este merge | 117 tests infra verdes; origen coherente y evidencia obligatoria, sin truncar cash nuevo |
| LM-E-docs | README/docs/colección del contrato aprobado | INTEGRADA: 4f9974f/e27f99a/ee5703f + cierre final | ejecución automatizada verificada; no se afirma corrida manual íntegra de colección |
| LM-E-wire-final | OpenAPI; cell/large-money-wire-final | INTEGRADA: 3477ff9 | 15 tests/docs re-corridos; schemas monetarios únicos; lint verde |
| LM-F-trading | tests/functional/{orders,orders-submit}; cell/large-money-functional-trading-final | INTEGRADA desde 4cb6324 (360ae4e) | 47 tests HTTP+PG re-corridos; gate completo detectOpenHandles=[] |
| LM-F-cash | tests/functional/{read,cancel,transfers}; cell/large-money-functional-cash-final | INTEGRADA desde 0ccebda en este merge | 42 tests HTTP+PG re-corridos; typecheck/lint verdes; 0.50 FILLED exacto por D4 |
| LM-F-acceptance | tests/functional/large-money nuevos; cell/large-money-acceptance-final | INTEGRADA desde 54ef051 en este merge | 19 E2E re-corridos; máximos/centavos/concurrencia/replays/rollback real |
| LM-QA | Revisión independiente de diff e invariantes del runtime b55a8db | ACCEPT runtime, 8.5/10 (DeepSeek); ampliada por LM-QA-final | matriz invariante → implementación → test entregada; e2e final y revisión9.0/10 completadas |
| LM-QA-polish | Precisión docs CHECK y tipos financieros de price-source/support | INTEGRADA desde 046442a en este merge | 96 tests infra/docs re-corridos + typecheck/lint verdes; sin cambio de lógica |
| LM-env-hygiene | Exclusión del archivo real .env.test; cell/large-money-env-final | INTEGRADA desde 7a76046 en este merge | copia local preservada byte a byte y ahora ignorada; sólo ejemplo versionado; sin rewrite |
| LM-docs-close | README/API/colección y evidencia única de ejecución; cell/large-money-docs-close | INTEGRADA desde 9400fe5 en este merge | correcciones leídas/aceptadas; gate completo37/515 re-corrido, sólo diff documental |
| LM-QA-final | Revisión independiente del candidato completo 1bd02e4 | ACCEPT, 9.0/10 (DeepSeek) | revisor re-corre19E2E +79domain/docs; coteja JSON37/515 yopenHandles=[]; sin blocker |
| Integración main | Fast-forward autorizado + verificación en worktree original | DONE, integración24bca18 | 37 suites / 515 tests repetidos en main; 0 handles; entorno local intacto; sin push ni migración app |

### Decisiones operativas

- Sin recortes de aceptación. Rutas disjuntas y worktree por célula, con npm ci offline y Prisma Client generado antes del dispatch.
- Sólo PostgreSQL de test aislado. LM-B tiene bases prefijadas `lm_b_`; las suites de integración finales usarán el cluster efímero, nunca el destino de la app.
- La firma D5 permite personalizar la migración nueva aún no aplicada; no editar la inicial ni usar db push.
- La preparación no actualiza dependencias: Node 26.12.1, npm 12.0.2 y Prisma 7.10.1 verificados. Avisos de npm sobre dependencias no se consideran una auditoría completa de seguridad.

### Reanudación y ownership T13/T14

- Base de reanudación ee5703f; se integraron C0, B y E-docs. Gate de seams re-corrido: 4 suites / 50 tests (contratos + storage PG + CODEMAP). Esto NO es un gate de feature: typecheck/global y consumidores siguen pendientes.
- Última corrida global previa (46fcb36): 34 suites, 325/380 tests pasan; 55 fallos. Funcionales: 36/86 pasan. Probes en DB aislada reprodujeron 123.45 → 123, 0.01 → ZERO_SIZE y falsa equivalencia idempotente 123.01/123.99. No integrar ese comportamiento a main.
- LM-C1-pure: src/domain/{portfolio,sizing,matching}/index.ts, src/domain/{index.ts,ports/index.ts}; tests/unit/domain/{helpers.ts,portfolio.test.ts,portfolio-characterization.test.ts,portfolio-total-account-value.test.ts,sizing.test.ts,matching.test.ts}. CODEMAP sólo filas dominio/ports.
- LM-D-final: src/infra/prisma/{mappers,order-repository,portfolio-read-repository,marketdata-repository,marketdata-price-source}.ts; tests/unit/infra/mappers-filled-price.test.ts; tests/integration/infra/{support,portfolio-read-repository.test,order-repository.create-order.test,order-repository.idempotency.test,order-repository.transaction.test,marketdata-repository.test}.ts; tests/helpers/factories.ts. Puede extraer helpers de infra si lint lo exige y registrar CODEMAP sólo sus filas.
- LM-E-wire-final: scripts/openapi/{wire,registry,build}.ts, scripts/generate-openapi.ts, openapi.json, tests/docs/openapi.test.ts; CODEMAP sólo filas de herramientas.
- LM-C1-app (después de pure): src/application/**, src/http/{shared/edge,portfolio/portfolio-router,orders/orders-router,transfers/transfers-router,instruments/instruments-router}.ts, tests/unit/{application,http}/**, tests/helpers/fakes/submit-order-fakes.ts; CODEMAP sólo application/HTTP.
- LM-E-functional (después de código estable): tests/functional/**, con inventario y cortes de máximo 2 archivos por adaptación. Nuevas suites de aceptación con DB propia; sin colisión con integración.
- Ninguna célula cambia specs, DECISIONS, deps, migraciones aplicadas, DB app o main. Nuevos archivos de src sólo para extraer funciones financieras por umbral de lint, sin ampliar diseño; CODEMAP en el mismo commit. Los cambios compartidos se integran secuencialmente.

### Auditoría de integración (GLM, revisada por el orquestador)

- Verificado: main 60b3764 es ancestro de feature; las 26 rutas del snapshot b8006af coinciden byte a byte con el árbol original, sin drift. La rama de instrumentos NO es ancestro. Esto habilita un fast-forward de commits, no garantiza ausencia de obstáculos en un worktree sucio.
- Preservar el índice original: `.env.test` tiene eliminación staged en main pero sigue rastreado en el snapshot/feature. El cierre debe excluirlo del árbol versionado sin perder su copia local; no leer ni imprimir contenido ni credenciales. La historia local ya existente no se reescribe sin permiso y no hay push autorizado.
- Se acepta respaldo recuperable antes del fast-forward; se rechaza asumir que `stash -u` preserva por sí solo el archivo local en todos los estados, o que eliminar `.env.test` del índice deja un diff vacío contra una feature que aún lo rastrea. Revalidar rutas, archivos ignorados y tip final antes de integrar. No aplicar stash automáticamente si sus cambios ya están incorporados.
- La migración de la DB de la app sigue FUERA de alcance. Los gates usan exclusivamente el cluster efímero de test; no equivalen a despliegue sobre el esquema viejo de la app.
- Respaldo previo al merge creado en scratch privado del perfil: lm-main-before-integration, con índice original, patches staged/unstaged y 27 archivos (incluye env local sin imprimir contenido). Revalidación: las26 rutas del snapshot siguen coincidiendo, drift vacío; main sigue60b3764. Stash recuperable se hará sólo al integrar, sin pop automático porque cambios previos ya están en snapshot.

### QUESTIONs activas

Ninguna. Si una decisión de diseño no está expresada en la spec firmada, detener esa parte y preguntar; no ampliar alcance.

### Revisión de la reanudación

- Dominio y OpenAPI aceptados: 3938ec0/3477ff9. Gate conjunto re-corrido: 7 suites / 79 tests (domain + docs), lint y diff-check verdes. Checkpoint global explícitamente rojo: 40 diagnósticos TypeScript en app/HTTP/infra/tests aún pendientes; no es cierre de feature.
- LM-D 8287dfa devuelve replay antes de leer evidencia cuando stored == requested. REJECT de revisión: histórico pedido 123.45, guardado 123, retry 123.00 debe ser conflicto; evidencia ausente o corrupta no se vuelve suficiente por igualdad de size. Se delegó TDD del caso y validación del evento origen para todo replay cash, reutilizando gramática de contracts (sin duplicación).
- LM-D revisión cerrada en 86dcbb4: evidencia obligatoria aun si stored == retry, schema monetario único, primer evento coherente FILLED/ACCEPTED o REJECTED/REJECTED; NEW/CANCELLED no justifican replay cash. Se acepta exigir evento a fixtures de repo porque la app lo escribe atómicamente. Errores app no generan ticket ajeno: pertenecen a la célula activa.
- Gate integrado dominio + infra + docs re-corrido: 15 suites / 196 tests verdes con PostgreSQL test real, lint/diff-check verdes. Checkpoint global aún rojo: 24 diagnósticos TypeScript, todos en app/HTTP y sus fakes/tests asignados a LM-C1-app. Main permanece sin tocar.
- LM-C1-app aceptada en 835699a: bases distributivas preservan unidades de draft, cash exacto sin sizing de acciones, quantity bigint interno/string HTTP, RangeError de sizing mapeado a400 sin writes (otros errores propagan). Se acepta omitir residualArs en eventos nuevos de cash porque ya no hay floor; amountArs canónico sigue siendo evidencia de origen.
- Gate del runtime integrado: typecheck + lint + build verdes; 29 suites / 403 tests unit/docs/integration verdes con PostgreSQL real. Las suites funcionales previas aún requieren adaptación y pruebas de aceptación nuevas: no afirmar cierre global ni ejecución final de colección.
- Probes del orquestador contra app compilada y DB nueva lm_diagnostic_test (2 migraciones + seed): CASH_IN123.45 persiste123.45 y responde size string; CASH_IN0.01 persiste0.01; misma key123.01→123.99 devuelve409. Portfolio final de esas pruebas cash246.47, exacto. Los3 defectos concretos iniciales ya no se reproducen; no sustituye el gate e2e completo.
- QA independiente sobre b55a8db: ACCEPT de runtime8.5/10, 82 tests puros re-corridos por revisor, sin bug de fuente confirmado. Se aceptan como pendientes las pruebas HTTP nuevas y concurrencia cash (células activas). Observación menor aceptada: CHECK size0 sólo acredita status REJECTED, no reason de evento; no se añadirá constraint cross-table. Importaciones de tipo price-source y constructor en soporte infra se alinean por T13. Downgrade DDL no prometido ni autorizado.
- T14 y aceptación cerradas: órdenes47, lectura/cancel/transfers42 y nuevos E2E19 re-corridos por el orquestador. Se acepta fixture cash con price1.00/size monto exacto y cuantización de presentación del SUM SQL en FinancialDecimal (sin tocar valores económicos ni ocultar resultados numéricos viejos).
- GATE COMPLETO de feature re-corrido con DBs recreadas: typecheck + lint + build + OpenAPI determinista verdes; npm test -- --runInBand --detectOpenHandles: **37 suites / 515 tests verdes**, openHandles=[] (despeja advertencia aislada anterior). Los2 logs de error HTTP corresponden a fallos de auditoría inyectados deliberadamente para probar rollback, no tests fallidos. Falta cierre documental y revisor del SHA final antes de integrar main.
- Límites de evidencia: quantity agregada >MAX_SAFE_INTEGER se probó en unit con órdenes INT4 válidas, no mediante millones de filas E2E; la migración y locks se ensayaron en DBs de test chicas, no en producción. Ninguna DB de app migrada ni push remoto realizado.
- QA final independiente acepta1bd02e4 con9.0/10, sin findings bloqueantes; re-ejecuta19E2E+79domain/docs y verifica515tests/openHandles[] del log. Se verificó que cambios posteriores propios sólo afectanPROGRESS (ya commiteado, árbol limpio), sin drift de runtime/tests/schema. Los2 gaps de cobertura E2E secundarios se aceptan como no bloqueantes por cobertura existente de eventoACCEPTED y guardas de evidencia/precio en integración; no ampliar diseño para perseguir10/10.
- Cierre documental105b623 devuelto por precisión: CHECKs de precios de orden son positivos, marketdata permite0; concurrencia asegura un débito no una sola escritura; evidencia no debe quedar desactualizada diciendo main pendiente; DBapp no fue consultada ni migrada por esta tarea. Se delegó corrección sólo documental antes del merge.
- Cierre documental9400fe5 aceptado por diff y lectura real: cinco precisiones resueltas. Gate completo posterior a integrar docs re-corrido: 37/515, openHandles=[], typecheck/lint/build verdes, OpenAPI sin diff. Evidencia única versionada en docs/references/large-money-verification.md. Árbol fuente/schema/tests idéntico al candidato core revisado1bd02e4.
- Cierre definitivo: main recibió24bca18 por fast-forward tras respaldo recuperable y comparación exacta del estado original. Gate post-merge ejecutado desde /home/cofi/repos/cocos-challenge-backend: 37/515 y openHandles=[], cliente Prisma7.10.1 regenerado, typecheck/lint/build/OpenAPI verdes. Código de instrumentos-current-quotes sigue fuera; sólo su spec preexistente del snapshot forma parte del árbol. Esta anotación final sólo cambia estado documental, no el runtime ya probado.
- Aceptadas las decisiones del dominio: builders cash/trading separados; cantidades acumuladas bigint probadas con órdenes INT4 válidas; matching conserva reglas y sigue sin disparador. No hay ampliación de diseño.

### Revisión intermedia del orquestador

- LM-A verificada sobre 607c138: 4 suites / 47 tests (incluye CODEMAP), build y lint verdes. Se devuelve para validar finitud también después de Number en serializePct y adaptar las dos operaciones monetarias de un test al string. El resto de consumidores se adapta en fases posteriores, no se afirma typecheck global verde.
- LM-B verificada sobre 11eb26d: 21 pruebas PostgreSQL reales; ALTER observado 95 ms en tabla chica. Se devuelve porque un CHECK debe tratar NULL explícitamente para que size=0 sólo permita REJECTED, y la suite no debe rechazar el nombre cocos_* del URL fuente global si sólo crea destinos propios lm_b_*.
- Resolución LM-A: no inventar prohibición de cero negativo en el schema firmado genérico de entrada; Positive lo rechaza y la salida lo normaliza. No requiere cambiar el diseño ni consultar un nuevo default.
- Seams de tipos se preparan en célula separada antes de paralelizar dominio/aplicación e infra; no se mezclan unidades mediante casts.
- Revisión LM-A cerrada en 462074f: overflow pct cubierto y typecheck recuperado. Commits integrados 51d5076/e676d90/3d20e69/1099fb4; 4 suites / 48 tests y typecheck/lint/build re-corridos por el orquestador. Gate de alcance, no final de feature: faltan consumidores del contrato incompatible.
- Revisión LM-B cerrada en afc5e5f: cero/status NULL rechazado y URL fuente global admitida sin DROP de esa base. 22 tests PG re-corridos (ALTER 95 ms en ensayo chico). Se espera integración con mappers para regenerar el cliente de la integradora; LM-D ya tiene cliente nuevo y base propia sin usar DB de app.

---

## Histórico del build inicial (cerrado; no describe las células LM)


## Estado actual

- **FASE 0** (Célula 0 — entorno): **DONE — merge `b590dfb`, GATE 0 verificado por el orquestador** (typecheck/lint/test verde, `test:db:reset` idempotente, Prisma CLI 7.10.1 = client 7.10.1).
- **FASE 1** (Célula 0 — contratos): **DONE — merge `86bc9c3`** (5 commits + corrección tx `bf4b992`). GATE 1 re-corrido por el orquestador: `prisma validate` + typecheck + lint + tests 4/4 + `test:db:reset` idempotente con columnas nuevas. `DECISIONS.md` verificado byte-exacto contra el reference.
- **FASE 2** (paralelo): **DONE — GATE 2 cerrado.** A merge `1f4bdba` (44 tests), B merge `54cdd40` (34 tests), C merge `1e27c94` (15 tests, golden values verificados por la célula contra la DB: 627500/125500/764256), D merge `18b16bd` (matriz roja — su DONE = typecheck+lint verde + 25 reds por 404-asserts). Todos los gates re-corridos por el orquestador. Post-B: `npm install` en main por `@prisma/adapter-pg` (TS2307). Composition root `server.ts` montando lectura (C) @ `9d2f6b8` + fix de imports `98a25fb` (commiteé con typecheck rojo — `&&` no frenó la cadena; lección: gate explícito antes de commit). Suite main: 12 suites → 89 passed + 25 reds (matriz D, esperados hasta FASE 3). Sanity vivo: portfolio 200/cash 627500/3 posiciones; search "pam"→PAMP; POST orders→404.
- **FASE 3** (Célula E — UC-3): **DONE — GATE 3 cerrado.** Merge `1233c66` + integración `bae8eed`: mapper `filledPrice ?? price` (seam B↔DECISIONS.md reportado por E, QUESTION opción A), router orders cableado en `server.ts`, `jest.config.js` con projects (la suite de D no setea `DATABASE_URL` y GATE 3 la corre sin modificarla → proyecto uc3-functional apunta a `cocos_challenge_ftest`, su misma DB de asserts). **Suite main: 13 suites / 134 tests — los 25 de D en verde SIN tocar un archivo suyo.** Decisiones de E aceptadas: LIMIT+amountArs dimensiona por límite (GTC no resuelve ref); NO_PRICE con amountArs persiste size 0; INSTRUMENT_NOT_FOUND → 404 (DECISIONS no fija status para instrumento inexistente; spec Rev.3 sugería 400 — documentar en README); replay REJECTED devuelve reason null; SELL valida contra posición FILLED − reservadas (BMA −10 ⇒ vendible negativo).
- **FASE 4** (F cancelar + G transferencias): **DONE — GATE 4 cerrado.** F merge `b915058` (cancelOrder: guard atómico `WHERE status='NEW'` dentro de `withUserTransaction`, 422 sin mutar, 404/400, doble DELETE concurrente ⇒ una 200 + una 422, liberación de reserva visible en portfolio — 11 tests). G merge `086dd89` (submitTransfer espejando E: transferencias = orders del instrumento ARS id 66 con `price=1.00, size=pesos` — convención del seed; CASH_OUT valida contra DISPONIBLE dentro de la tx; el caso clave 630000 < settled 753000 pero > disponible 627500 ⇒ REJECTED — 14 tests). Gates re-corridos por el orquestador en ambos worktrees (145/145 y 148/148). Cableado `server.ts` @ `8bbac23` ⇒ **GATE 4: 15 suites / 159 tests verde**. Sanity vivo de los 5 endpoints: portfolio 200 (cash 627500), search METR, POST LIMIT de user 2 sin cash ⇒ REJECTED (fondos), cancel de REJECTED ⇒ 422 (guard), transfer IN ⇒ FILLED, OUT excesiva ⇒ REJECTED.
- **FASE 5** (Célula H — docs y entrega): **DONE — GATE 5 cerrado por el orquestador como revisor independiente.** Merge `8f23a5c` (README con 27 decisiones documentadas, docs/database.md corregido legacy vs migrado, collection/ REST Client con un ejemplo por caso). GATE 5 (revisor distinto del autor, DB limpia nueva `cocos_challenge_gate5`): drop/create → `migrate deploy` → seed (4/66/11/126) → `test:db:reset` + **`npm test` 15 suites / 159 tests verde** → server vivo + requests reales: portfolio golden (627500/125500/764256), búsqueda, transfer CASH_IN FILLED, orden LIMIT GTC NEW, **replay idempotente (misma id 13)**, **409 con otra key=payload**, 404 orden inexistente, **DELETE NEW → 200 CANCELLED**, DELETE repetido → 422, reserva liberada visible en portfolio (user 2: reserved 9000→0, cash 50000). Lint 0 warnings (fix propio de la directiva sin uso en `src/index.ts`).

**DEFINICIÓN DE TERMINADO — VERIFICADA (2026-11-03):** `typecheck && lint && test` verde desde DB limpia ✓ · 5 endpoints cumplen DECISIONS.md ✓ (verificados en vivo) · matriz UC-3 completa (los 25 de la Célula D en verde sin editarlos) ✓ · README con "Supuestos y decisiones" (27) y "Evolución propuesta" (7) ✓ · cero decisiones sin documentar ✓.

### Decisiones firmadas por el orquestador en FASE 4 (para el README de H)

1. DELETE exitoso de cancelación ⇒ **200** con OrderResponse (201 es para creación; DECISIONS.md no fija el status).
2. Evento CANCELLED por usuario: reason null, metadata origen `USER`.
3. Transferencias: instrumento del cash resuelto por ticker `"ARS"` vía port (QUESTION de G, opción A).
4. size en transferencia REJECTED = monto pedido (no 0); ZERO_SIZE sub-peso ⇒ REJECTED persistida (rama agregada por G, testeada).

### Lecciones de FASE 2 (para merges de FASE 3+)

- Un merge que agrega dependencias (`@prisma/adapter-pg`) requiere `npm install` en main post-merge: el typecheck de main dio TS2307 hasta sincronizar node_modules (ya corregido, main en verde 10 suites / 74 tests).
- Worktrees nuevos (`npm ci`) necesitan `npx prisma generate` antes de que compile cualquier import de `@prisma/client` (factories lo usan). Correrlo con `DATABASE_URL=<placeholder válido> npx prisma generate` (no toca DB).
- DBs aisladas por suite (script `TEST_DB_NAME`): B→`cocos_challenge_test`, C→`cocos_challenge_read`, D→`cocos_challenge_ftest`. Cada suite se auto-resetea; ninguna pisa la de otra.

### Scaffolding del orquestador para FASE 2 (`5fbfbbc`)

- `jest.config.js`: `moduleNameMapper` `.js`→`.ts` (jest-resolve no mapea extensiones ESM).
- `src/http/app.ts`: `buildApp(routers)` — composición por inyección: cada slice exporta su Router factory con deps (ports) inyectadas; los tests componen localmente y nadie compite por un archivo compartido.
- `src/http/server.ts`: `serverApp = buildApp([])` — stub que responde 404 en todo, para que los tests rojos de D fallen por 404 y no por setup. La composición real la monta la célula integradora de cada fase.

### Interpretación firmada por el orquestador (derivada de DECISIONS.md, valida el modelo de reservas)

- Validación de fondos de BUY (MARKET y LIMIT) contra **cash disponible** (`cashSettled − cashReserved`), y de SELL contra **acciones vendibles** (`posición − reservadas`): las reservas son compromisos reales ("cash = cashSettled − cashReserved"; CASH_OUT valida contra lo disponible). El test de "dos órdenes simultáneas que juntas exceden el cash ⇒ una FILLED y una REJECTED" se escribe contra esta lectura.

### Interpretaciones DECISIONS fijadas en contrato por la Célula 0 (aceptadas por el orquestador)

- MARKET con `price` en el body => 400 (no crea orden).
- IOC/FOK sin precio de referencia => REJECTED persistida con `NO_PRICE`; GTC LIMIT sin precio => NEW (resting no necesita ref para nada); MARKET sin precio => REJECTED `NO_PRICE`.
- Búsqueda responde array plano (sin wrapper). Query vacía o ausente => 400.
- `timeInForce` NOT NULL DEFAULT 'GTC' en DB (toda orden conoce su TIF; seed queda en GTC; TIF se ignora para MARKET).
- `datetime`/`filledAt` serializan ISO 8601 **sin offset** (timestamp sin tz, hora local del mercado).
- Nombres estables de error codes: VALIDATION_ERROR, INSTRUMENT_NOT_OPERABLE, USER_NOT_FOUND, ORDER_NOT_FOUND, IDEMPOTENCY_CONFLICT, ORDER_NOT_CANCELLABLE.

### Notas de FASE 1 para las células de FASE 2

- `@prisma/adapter-pg` (driver adapter, EXIGIDO por Prisma 7 para instanciar el cliente): **aprobado por el orquestador** para la Célula B — es parte del stack Prisma ya elegido por el repo, no una decisión nueva de diseño.
- jest-resolve NO mapea `.js`→`.ts`: ANTES de lanzar FASE 2 el orquestador agrega `moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }` a `jest.config.js` (ruta del orquestador — las células no pueden tocar jest.config.js).
- Generador Prisma: `prisma-client-js` (emite `.js`+`.d.ts` a `node_modules/.prisma/client` — compatible con tsc nodenext + jest CJS + eslint sin tocar configs). El nuevo `prisma-client` solo emite `.ts` y rompería el lint.

### Decisiones aceptadas por el orquestador en FASE 0 (reportadas por la célula)

1. **TypeScript ^7.0.2 → ^5.9.3**: TS7 (compilador nativo) removió la API JS de `require('typescript')`; ts-jest y typescript-eslint dependen de ella. 5.9.3 es la única línea que satisface ambos peers pedidos por el plan. Reversible con bump de devDep.
2. **@types/pg@^8.23.1** (types-only): pg no bundlea tipos y el humo de DB usa pg bajo strict/no-any.
3. **npm allowScripts** aprobado para prisma + @prisma/engines (sin postinstall de ellos el CLI 7.x no baja binarios). esbuild y @parcel/watcher SIGUEN bloqueados → **limitación conocida**: `npm run dev` (tsx watch) puede fallar en FASE 3; los gates del plan no lo incluyen.

### Notas técnicas heredadas (de FASE 0, para las células siguientes)

- App ESM (`type: module`, tsconfig nodenext); tests compilados a CJS por ts-jest (`tsconfig.test.json`).
- `import { Decimal } from 'decimal.js'` (named) bajo nodenext — el default export del d.ts no tiene construct signature.
- Prisma 7 no autocarga `.env`: la URL del datasource se resuelve vía `prisma.config.ts` (`defineConfig` de `prisma/config`).
- `npm run build` compila también `tests/` (no hay rootDir): si FASE 3 quiere dist limpio, hace falta `tsconfig.build.json`.

## Referencia del seed

- User 1 (calculada contra el seed): cashSettled=753.000,00 · cashReserved=125.500,00 · **cashDisponible=627.500,00**.
- PAMP qty 40 (close 925,85 · 14-jul) · METR qty 500 (close 229,50) · BMA qty −10 (close 1.502,80).
- Sin marketdata (→ NO_PRICE): PGR, IRCP. ARS (id 66, MONEDA): no operable.
- `package.json` de partida con deuda conocida: prisma@8-rc (CLI de Platform, no ORM) vs
  @prisma/client@7.10.1 · postinstall ajeno (`prisma skills sync`) · `prisma:seed` apunta a
  `prisma/seed.ts` inexistente · `type: commonjs` vs ESM mandatorio en AGENTS.md.

## Células

| Célula | Fase | Estado | Gate |
|---|---|---|---|
| 0 — entorno | 0 | **DONE (merge `b590dfb`)** | GATE 0 ✓ |
| 0 — contratos | 1 | **DONE (merge `86bc9c3`)** | GATE 1 ✓ |
| A — dominio puro | 2 | **DONE (merge `1f4bdba`)** | GATE 2 ✓ |
| B — persistencia e infra | 2 | **DONE (merge `54cdd40`)** | GATE 2 ✓ |
| C — endpoints de lectura | 2 | **DONE (merge `1e27c94`)** | GATE 2 ✓ |
| D — tests funcionales UC-3 (rojos) | 2 | **DONE (merge `18b16bd`)** | GATE 2 ✓ |
| E — integración UC-3 | 3 | **DONE (merge `1233c66`)** | GATE 3 ✓ |
| F — cancelar orden | 4 | **DONE (merge `b915058`)** | GATE 4 ✓ |
| G — transferencias | 4 | **DONE (merge `086dd89`)** | GATE 4 ✓ |
| H — docs y entrega | 5 | **DONE (merge `8f23a7c`)** | GATE 5 ✓ |

## QUESTIONs abiertas

(ninguna)

## Limitaciones acumuladas (input del README de FASE 5)

- Alcance cerrado por DECISIONS.md: sin Yahoo, sin price_ticks/ingesta, sin DAY/EXPIRED,
  sin sweep, sin matching continuo, sin fills parciales, sin prioridad precio-tiempo
  → van a "Evolución propuesta" del README, no al código.
- Posición negativa del seed (BMA −10) se lista tal cual: inconsistencia del dataset,
  documentada, no "corregida" por el código.
- Las pruebas de integración usan el PostgreSQL configurado por `TEST_DATABASE_URL`, separado de
  `DATABASE_URL` runtime; puede ser local o administrado. No se asume proveedor, host ni puerto.
  `docker-compose.yml` queda como opción de entorno, no como requisito de la aplicación.

- **Wave 2 integrada (2026-11-06)**: `main` recibió `d7663d1` por fast-forward (bind loopback: único cambio de código, `src/index.ts`) y luego el merge `5645896` de los dos documentos del diagrama. Gate del padre sobre `main`: **typecheck exit 0 · lint exit 0 · `npx jest tests/docs` 2 suites / 15 tests verdes**; `git status` limpio. API viva (PID 142357) y PG activos al cierre de A4, como exige G4. Pendiente de cierre: suite completa (gate final, corre el padre) una vez que A5 reporte.
- **Lección de A4 (para la skill)**: `listen(port)` sin host bindea `*:3000`; la URL del `.env` no prueba la URL efectiva porque `dotenv` inyecta después del `exec` (por eso `/proc/<pid>/environ` no la muestra). Verificar el bind REAL con `ss -lntp` y, si hace falta, corroborar la URL dentro del proceso o por `pg_stat_activity`.

- **G5 cerrado, verificado por el supervisor (2026-11-06)**: ejecuté mi propio probe replicando `fetch(url, { signal })` **sin headers** (idéntico al adaptador) contra `query1` ⇒ **HTTP 200** con precios reales y `currency=ARS` de la sesión **2026-11-05 17:59 ART** (última rueda; mercado cerrado al medir). `GGAL 4997.50 / PAMP 4277.50 / BMA 9810.00 / METR 2228.00 / YPFD 6475.00`. Los 4 no cubiertos (DYCA, PGR, IRCP, MTR) confirman **404**. Cross-check decisivo: `GET /api/instruments?limit=100` devuelve **61 ítems** y sus precios coinciden **exactamente** con mi probe (5/5 muestreados) ⇒ lo que sirve la API ES Yahoo en vivo, sin caché ni seed. **Veredicto: integración exitosa completa** en el eje de proveedor; 0 respuestas 503 y 0 rate-limits desde la aplicación.
- **Corrección de la medición del supervisor (importante)**: mi medición anterior («UA de navegador ⇒ 200») **ya no se reproduce**: `curl` con UA de navegador Y con UA default devuelven **429** hoy. El rate-limit de Yahoo es dependiente del cliente **y variable en el tiempo**. Conclusión: el 429 de `curl` **no es señal de salud del proveedor**; el camino real de la app (undici sin headers) sí responde. **No aplica el BLOQUEO** decidido por el humano y **no se toca el adaptador** (sin User-Agent, sin reintentos, sin caché).
- **DECISIÓN HUMANA (2026-11-06): opción A — el catálogo NO se modifica.** DYCA / PGR / IRCP / MTR seguirán dando 404 en Yahoo (desafectados o absorbidos; IRCP se fusionó con IRSA). Está aceptado explícitamente que el contrato los omite y que el cupo se completa con los 61 restantes. Depurar/remapear queda descartado para este rollout por ser cambio de dataset que exige fase con DDL/seed permitido.
- **Limitación de UC-1 (registrada, no oculta)**: UC-1 **NO** ejercita Yahoo. `GET /api/users/{userId}/portfolio` toma precios de la tabla `marketdata` (`getLatestSnapshots`), y esos snapshots son del 2023-07-14 (BMA 1502.80, PAMP 925.85, METR 229.50) — son los que producen los `marketValue` del golden. Es decir: el golden de UC-1 valida la **aritmética** del portfolio sobre snapshots persistidos, **no** precios vivos. La única verificación de Yahoo en vivo es UC-2.

- **GATE FINAL DE CIERRE (supervisor, 2026-11-06)** — ejecutado desde `main` con la topología aprobada:
  `npm run typecheck` exit 0 · `npm run lint` exit 0 · `npm run build` exit 0 ·
  **`TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/cocos_challenge_test npm test -- --runInBand --detectOpenHandles`
  ⇒ **42 suites / 581 tests passed**, exit 0, sin `FAIL` y sin open handles.
  Evidencia privada: `run-logs/instruments-rollout-20261105/main-final-gate-jest.log`. `git status` vacío; sin push.
- **Dos incidencias del proceso de cierre, registradas con su causa**: (1) usar `…/postgres` como
  `TEST_DATABASE_URL` — las suites de integración lo toman literalmente como `DATABASE_URL`, así que
  apuntaban a la DB admin vacía y produced 63/64 fallos espurios; (2) el `.env.test` heredado
  apunta `TEST_DATABASE_URL` al cluster de la **app** (5433), cuya `cocos_challenge_test` estaba
  **obsoleta** (sólo `init_trading_api`). Ninguna fue regresión de código: con
  `TEST_DATABASE_URL` correcto y la base recreada desde migraciones + seed, la suite pasa completa.

- **ROLLOUT CERRADO (2026-11-06)** con la decisión A del humano. Estado final verificado por el supervisor: `main` limpio, **1 worktree**, migración de grandes montos aplicada a la DB app con fingerprints económicos idénticos antes/después, API viva en `127.0.0.1:3000`, Yahoo en vivo funcionando por el camino real de código, y suite completa **42 / 581 en verde**. Sin push (no pedido).

---

## Activo — REMEDIACIÓN DE LA REVISIÓN DE CALIDAD (`specs/remediacion-revision-calidad.md`)

**Fuente inmutable:** `specs/remediacion-revision-calidad.md` (borrador Rev. 1, `972746a`).
**Decisiones humanas ya firmadas (2026-11-06):** **Q1 = A** (columna `requestFingerprint`, migración
create-only; por eso en la Wave 3 el DDL lo define **F3-DB y lo consume F2-IDEM**) · **Q2 = A**
(retorno con denominador `|costBasis|`: gana ⇒ positivo, pierde ⇒ negativo).

**Entorno (medido, no asumido):** cluster userspace `~/.pg/cocos` en `127.0.0.1:5433`, que es lo que
espera `.env.test`. **Pitfall:** `pg_isready -p 5433` usa el socket de `/var/run/postgresql` y da
falso negativo; chequear por TCP (`pg_isready -h 127.0.0.1 -p 5433`). `npm run test:db:reset`
recrea las bases y deja los setval golden 4 / 66 / 11 / 126.

**Wave 1 — CERRADA E INTEGRADA** (4 células en worktrees propios, rutas disjuntas; gate completo
re-corrido por el orquestador después de CADA merge):

| Célula | Rama / SHA | Verify re-corrido por el orquestador | Merge |
|---|---|---|---|
| F1-PNL | `cell/f1-pnl` `0aa2143` | typecheck 0 · lint 0 · 6 suites / 74 tests | `8de100f` |
| F5-EDGE | `cell/f5-edge` `5910734` | typecheck 0 · lint 0 · 3 suites / 29 tests · `openapi.json` sin diff | `597e0b4` |
| F7-DOCS | `cell/f7-docs` `b9a4321` | typecheck 0 · lint 0 · 2 suites / 16 tests | `57c71d4` |
| F8-VERIFY | `cell/f8-verify` `80eda82` | typecheck 0 · lint 0 · `test:no-db` 29 suites / 375 tests con DB muerta | `44bc3f2` |

**Seams resueltos por el orquestador en el merge (no delegados a células nuevas):**
1. `tests/functional/read/read-endpoints.test.ts:153` congelaba `totalReturnPct: -2.42` para BMA;
   con Q2=A pasa a `+2.42` (costo base −15400,00 ⇒ ganancia 372,00). Corregido con su comentario.
2. La guardia **D3** (aportada por F7) detectó que F5 agregó 7 exports a `src/http/shared/edge.ts`
   sin documentarlos: **la guardia funcionó** y el gate quedó rojo hasta actualizar la fila de
   CODEMAP (`28c2d7e`). Es la prueba de que D3 no es decorativa.
3. `AGENTS.md` §2 no listaba `test:no-db` (agregado en `28c2d7e`).

**Gate final de la Wave 1 (HEAD `28c2d7e`):** typecheck 0 · lint 0 · **44 suites / 596 tests** en
verde, contra PostgreSQL real en 5433. Sin push (no pedido).

**Deuda arrastrada, no introducida:** la corrida completa sigue emitiendo
`A worker process has failed to exit gracefully` — hay handles sin cerrar en alguna suite. No rompe
el gate, pero contradice el `openHandles=[]` que afirma la sección del rollout más arriba. Pendiente
de diagnosticar (`--detectOpenHandles`), no bloquea las waves siguientes.

**Worktrees vivos (ya integrados, pendientes de limpieza):** `coccb-wt-f1-pnl`, `coccb-wt-f5-edge`,
`coccb-wt-f7-docs`, `coccb-wt-f8-verify`. Las ramas quedan por si hay que relanzar una célula.

**Auditoría documental externa (delegada, y contrastada por el orquestador):** una célula
auditora revisó ~348 afirmaciones de la documentación contra el código y el entorno. Encontró
**23 contradicciones comprobadas y 9 sospechas**. El orquestador re-verificó una por una las de
mayor impacto y **todas sostienen**. La más grave era propia: el gate 44/596 de la Wave 1 se
había medido sobre un árbol sucio (el fix del golden de BMA quedó sin commitear) ⇒ corregido en
`cd3f4b5`. Las otras ya resueltas: signo del P&L en `openapi.json`/`registry.ts` (`c35989a`),
`AGENTS.md` vs los 6 CHECKs (ver §BLOQUEADO), `db-schema-before-after.md` vs G3, fórmula de
retorno en `specs/trading-api-domain.md`, colección `.http` de UC-2, y el README completo.
Número corregido: `test:no-db` es **30 suites / 386 tests**, no 29/375 (aquel era del worktree
de F8 antes del merge).

**Wave 2 — CERRADA E INTEGRADA:**

| Célula | Rama / SHA | Verify re-corrido por el orquestador | Merge |
|---|---|---|---|
| F4-RUNTIME | `cell/f4-runtime` `a8d2a85` | typecheck 0 · lint 0 · 4 suites / 40 tests · `PORT=abc` ⇒ exit 1 con mensaje | `b462a19` |
| F6-QUOTES | `cell/f6-quotes` `54c448a` | typecheck 0 · lint 0 · 5 suites / 48 tests (UC-2 completas) | `b86b26a` |
| F9-README | `cell/f9-readme` `dab4240` | typecheck 0 · lint 0 · 16 tests docs · 44/596 repetido 3× por la célula | `da7c286` |
| F10-DOCS2 | `cell/f10-docs2` `578b768` | typecheck 0 · lint 0 · 16 tests docs (D2–D6; D1 bloqueado) | `9e64e7c` |

**Seams de la Wave 2 resueltos por el orquestador:** la guardia **D3/D4b** volvió a hacer su
trabajo — F4 agregó `src/http/health.ts` y `src/lib/runtime-config.ts` (exports sin documentar) y
dos rutas (`/health`, `/health/ready`) fuera del registro OpenAPI. El gate quedó rojo hasta
documentarlos en CODEMAP, `registry.ts` y `docs/api.md` (`2f0a4c1` aprox., ver `git log`).

**Gate de la Wave 2 (HEAD posterior a los seams): typecheck 0 · lint 0 · 46 suites / 613 tests.**
Worktrees de la Wave 2 eliminados y verificados; quedan sólo `main` y las ramas `cell/*`.

**BLOQUEADO (requiere autorización humana):** `AGENTS.md:95` sigue afirmando «No hay `CHECK` en
la migración — es deuda conocida, no una garantía», mientras la migración de grandes montos define
6 CHECKs. El runtime denegó el write a `AGENTS.md` tanto a la célula como al orquestador
(archivo de instrucciones protegido). **No se reintentó ni se buscó un rodeo.** Texto propuesto
en la conversación, pendiente de que el humano lo aplique o lo autorice.

**Wave 3 — CERRADA E INTEGRADA:**

| Célula | Rama / SHA | Verify re-corrido por el orquestador | Merge |
|---|---|---|---|
| F3-DB | `cell/f3-db` `ef0ed42` | typecheck 0 · lint 0 · `prisma validate` ok · 8 suites / 103 tests en DB de ensayo · md5 de filas idéntico antes/después | `bda64a1` |
| F2-IDEM | `cell/f2-idem` `87cd34d` (+`8bcfed6` del orquestador) | typecheck 0 · lint 0 · 48 suites / 641 tests | `f4920eb` |

**F3-DB:** entraron la columna `requestFingerprint` (nullable, sin UNIQUE), `NOT NULL` en
`orders.type/side/datetime` y `marketdata.instrumentid/date/close/previousclose`,
`UNIQUE(marketdata.instrumentid, date)` y un CHECK de que un `FILLED` tenga precio de ejecución.
Ensayada en `cocos_f3_rehearsal` (DB propia), sin tocar la DB de la app.
**Tres constraints quedaron fuera por decisión fundamentada** (verificada por el orquestador
leyendo los tests): `LIMIT ⇒ price NOT NULL`, `CASH ⇒ price = 1.00` y `CASH ⇒ instrumento = ARS`
romperían 5 tests que caracterizan el CONFLICT contra filas históricas inconsistentes — ese
comportamiento es deseado. `FILLED ⇒ filledPrice NOT NULL` estricto exige backfill de 7 filas
legacy (el dataset guarda la ejecución en `price`): queda como decisión humana pendiente.

**F2-IDEM:** la huella del request (`fp1:<sha256-32hex>` sobre instrumento resuelto · side ·
type · timeInForce · dinero a 2 dp · `amountArs` ORIGINAL · `size` explícito) se calcula antes de
`resolveSizing` y se compara en el claim: ambas huellas ⇒ manda la huella; huella NULL ⇒ cae a la
comparación histórica. Cierra el 409 faltante (1000.00 vs 1000.50 con igual `floor`).

**Corrección del orquestador sobre F2:** la célula dejó `submit-order.ts` (application)
importando de `http/shared/edge.ts`, violando la regla de dependencias de CODEMAP §2. Se movió
`requestFingerprintOf` a `src/contracts/request-fingerprint.ts` (capa neutral) en `8bcfed6`;
`grep "http/shared" src/application/` da vacío.

**INCIDENTE DEL BUILD (propio, registrado con su causa):** los worktrees compartían
`node_modules` por symlink al repo principal y `git worktree remove --force` **vació el
`node_modules` real**, dejando un symlink que se apuntaba a sí mismo (`FilesystemLoop`). Síntoma:
`npx tsc` intentando instalar `tsc@2.0.4` y exit codes absurdos (216). Recuperado con
`rm -f node_modules && npm ci && npx prisma generate`. Además, un `git add -A` del orquestador
metió ese symlink al índice (modo 120000) en `8bcfed6`; se sacó con `git rm --cached` y se
endureció `.gitignore` (`node_modules` con y sin barra) en `a57868d`. Lección ya cargada en la
skill `cell-orchestration`.

**ESTADO FINAL DEL BUILD (HEAD `a57868d`, árbol limpio): typecheck 0 · lint 0 · 48 suites /
641 tests.** Sin worktrees vivos (sólo `main`); las ramas `cell/*` se conservan. Sin push.

---

## Wave 4 — CERRADA E INTEGRADA (`specs/remediacion-wave-4.md`)

**Why de la wave:** el preflight del orquestador demostró que las invariantes de escritura que
faltaban **no** las bloqueaba el dataset (seed 11 órdenes y DB de la app 12: `LIMIT` sin `price`
= 0, cash con `price ≠ 1.00` = 0, cash con instrumento ≠ ARS = 0) sino los tests que insertaban
filas no conformes para caracterizar el CONFLICT. Era **deuda de cobertura, no de datos**.

| Célula | Rama / SHA | Verify re-corrido por el orquestador | Merge |
|---|---|---|---|
| F11-INVARIANTS | `cell/f11-invariants` `cd9d914` | typecheck 0 · lint 0 · `prisma validate` ok · 40 suites / 528 tests · ensayo en `cocos_f4_rehearsal` | `9ae93e9` |
| F12-HANDLES | `cell/f12-handles` `6f53fb4` | typecheck 0 · lint 0 · `npm test` ×2 sin el warning | `e3b60e0` |

**F11-INVARIANTS:** la comparación de identidad del request salió de `order-repository.ts` a
`src/infra/prisma/request-comparison.ts` (pura, sobre un tipo de fila propio) y los casos legacy
se prueban en `tests/unit/infra/request-comparison.test.ts` con filas construidas a mano, sin DB.
Con eso liberada la integración, entró la migración `20261106180000_db_write_invariants`:
backfill de los 7 `FILLED` heredados (`filledPrice = price`, idempotente) + tres CHECKs
(`LIMIT ⇒ price NOT NULL`, `CASH ⇒ price = 1.00`, `FILLED ⇒ filledPrice NOT NULL`), todos
`convalidated = true`.

**Decisión de F11 aceptada por el orquestador (con su trade-off):** la migración incluye un
**trigger** `orders_fill_execution_price` que copia `price` a `filledPrice` si entra NULL. Hace
falta porque `db/seed.sql` es generado, no se edita, y se carga **después** de migrar: su COPY de
`orders` no trae `filledPrice` y el CHECK estricto rechazaría las 7 FILLED del seed (medido).
Costo: la DB normaliza en vez de fallar ruidosamente ante una FILLED sin precio de ejecución; si
tampoco hay `price`, el CHECK sí falla (23514). Está justificado en la cabecera de la migración.

**Lo que NO entró, y por qué:** `CASH ⇒ instrumento = ARS` no es expresable como CHECK
(PostgreSQL prohíbe subqueries) y el trigger que lo resolvería leería `instruments` (dependencia
oculta + rompe la carga del seed): queda como invariante de aplicación, documentada.

**F12-HANDLES:** el culprit era `tests/functional/orders/create-order.test.ts`, que compone
`serverApp` con repos Prisma reales y cerraba el `pg.Pool` de `db.ts` pero **no** el singleton de
`src/lib/prisma-client.ts`; el pool quedaba vivo en el worker. Aislado con un testEnvironment
probe que imprime `process._getActiveHandles()` por archivo (no por conteo de warnings, que es
intermitente). Cerrado en `closeFunctionalDbPool()`.

**Deuda menor conocida:** conviven `orders_filled_requires_execution_price_check` (F3, débil) y
`orders_filled_requires_filledprice_check` (F11, estricta); la segunda implica la primera.
Redundancia inofensiva; limpiarla exigiría una quinta migración.

**ESTADO FINAL (HEAD `e3b60e0`): typecheck 0 · lint 0 · 49 suites / 656 tests, sin el warning de
handles en dos corridas consecutivas.** Sin worktrees vivos. Push a `origin/main` autorizado.


