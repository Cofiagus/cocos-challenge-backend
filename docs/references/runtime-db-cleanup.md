# Spec — configuración externa de PostgreSQL y limpieza de entorno

> **Archivado 2026-11-06 — documento histórico; no es fuente de verdad ni plan vigente.**
> Motivo: ejecutada — el runtime se configura con `DATABASE_URL`, la DB de test con
> `TEST_DATABASE_URL` y la dependencia de Neon se eliminó.
> Configuración vigente: `README.md` y `docs/database.md`.

> Rev. 2 — El runtime admite cualquier PostgreSQL vía `DATABASE_URL`; la DB de integración se configura aparte con `TEST_DATABASE_URL` y puede ser local. Decisión del usuario, 2026-11-04.

## Why

La entrega debe poder configurarse con una URL PostgreSQL provista por el entorno, sin credenciales ni instrucciones dependientes de una instancia de desarrollo específica. Las pruebas que modifican datos deben ejecutarse contra un destino de test aislado, nunca contra la base de la aplicación.

## What

- La aplicación usa `DATABASE_URL` suministrada por el entorno; la documentación explica cómo configurarla sin incluir una URL real ni credenciales.
- La configuración de ejemplo contiene placeholders no válidos como credenciales reales.
- La app no depende de un host o instancia PostgreSQL concretos: `DATABASE_URL` la aporta el entorno.
- Las suites que escriben/restablecen la DB usan `TEST_DATABASE_URL`, independiente de `DATABASE_URL`; hoy puede apuntar a PostgreSQL local de pruebas y en otros entornos a una DB exclusiva de test compatible.
- Se eliminan del setup de la app los valores de DB específicos de esta máquina; se conserva una guía genérica para preparar PostgreSQL de integración.
- La configuración y manejo de errores de ORM, tipos/rangos `INT4` y mapeo de errores HTTP quedan fuera de esta spec; se documentaron para otra sesión en el workspace privado del perfil.

## Constraints

- No copiar, registrar ni imprimir la URL de conexión con credenciales compartida en la conversación. Rotar esa credencial antes de volver a usarla; configurarla sólo en un `.env` ignorado o en el gestor de secretos del entorno.
- No conectar, migrar, sembrar, truncar ni resetear una DB externa durante este trabajo.
- `DATABASE_URL` es sólo runtime/app; las suites destructivas requieren `TEST_DATABASE_URL` distinta y guardas que rechacen la misma base/endpoint. Nunca hacer fallback de tests a la URL de aplicación.
- Las suites de integración pueden usar PostgreSQL local separado; no se exige un branch Neon de test ni se permite ejecutar resets contra la DB productiva.
- Conservar cobertura de tests y los datos de seed del challenge; no desactivar suites para evitar adaptar su configuración.
- Antes de eliminar scripts/configs, hacer snapshot Git de cambios previos y revisar el diff. No tocar el contrato de API.
- La salida pública explica cómo configurar `DATABASE_URL` y `TEST_DATABASE_URL`, sin hosts, passwords ni datos específicos de la máquina.

## Tasks (1–2 archivos por tarea; cada una con verificación)

1. **Inventario y snapshot de cambios**: revisar todos los archivos versionados que configuran, documentan o prueban la DB; separar URLs del servidor HTTP (`localhost:3000`, no DB) de URLs de PostgreSQL. Verificar `git status`, branch y HEAD. No borrar nada hasta tener snapshot seguro.
   - Verificación: inventario de rutas con referencias DB/locales y clasificación app/test/infra/docs; Git status y base registrados.
2. **Config pública de la app**: reemplazar valores sensibles o específicos de host en `.env.example` y documentar que `DATABASE_URL` se configura externamente; nunca agregar la URL real.
   - Verificación: `.env.example` tiene placeholders no secretos; búsqueda sobre archivos trackeados no encuentra URI PostgreSQL ni credenciales reales.
3. **Separación app/test**: las suites consumen `TEST_DATABASE_URL` explícita, mientras la app usa `DATABASE_URL`. Adaptar setup/reset para derivar DBs aisladas de test del endpoint de test y rechazar cualquier coincidencia de host/base con la URL de app antes de ejecutar comandos destructivos.
   - Verificación: tests abortan si falta URL de test o si comparte endpoint/base con app; prueba unitaria de la guarda con URL idéntica y URLs de bases separadas. Los tests DB se corren contra PostgreSQL local de test, nunca contra la DB productiva.
4. **Retirar configuración de app específica de desarrollo**: actualizar o retirar provisión de DB usada como runtime de app; conservar instrucciones sólo para test local genérico. Limpiar README, `AGENTS.md`, docs y comentarios de test que mezclen app y test.
   - Verificación: búsqueda en archivos trackeados no encuentra URL/credencial de DB o indicaciones de que la app dependa de un host local; referencias locales explícitamente limitadas a cómo correr tests.
5. **Consistencia y gates**: actualizar CODEMAP/docs/OpenAPI/test runner si cambian rutas o archivos; ejecutar typecheck, lint, suites unitarias, suite completa y guardias docs/OpenAPI; verificar que no se alteró el contrato ni los golden values del challenge.
   - Verificación: outputs reales de cada comando, git diff revisado y `git status` explicado.

## Abierto antes de ejecutar

- Rotar la credencial que se compartió en el chat y configurar una nueva URL de app en `.env` ignorado, sin volver a compartirla.
- Confirmar/configurar `TEST_DATABASE_URL` local separada. El script actual hace DROP/CREATE DATABASE: probarlo sólo contra una base local de test aislada y conservar la guarda que prohíbe usar `DATABASE_URL`.
