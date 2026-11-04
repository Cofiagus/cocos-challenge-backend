# Spec — configuración externa de PostgreSQL y limpieza de entorno

## Why

La entrega debe poder configurarse con una URL PostgreSQL provista por el entorno, sin credenciales ni instrucciones dependientes de una instancia de desarrollo específica. Las pruebas que modifican datos deben ejecutarse contra un destino de test aislado, nunca contra la base de la aplicación.

## What

- La aplicación usa `DATABASE_URL` suministrada por el entorno; la documentación explica cómo configurarla sin incluir una URL real ni credenciales.
- La configuración de ejemplo contiene placeholders no válidos como credenciales reales.
- El repo no conserva referencias de configuración a un servidor PostgreSQL instalado para desarrollo ni URLs de DB con host local.
- Las suites que escriben/restablecen la DB usan una URL separada, `TEST_DATABASE_URL`, asociada a un branch/base Neon dedicado a pruebas. No comparten la URL de la aplicación.
- Se eliminan del repo los artefactos de provisión de DB local y se actualizan las instrucciones de desarrollo/test afectadas.
- La configuración y manejo de errores de ORM, tipos/rangos `INT4` y mapeo de errores HTTP quedan fuera de esta spec; se documentaron para otra sesión en el workspace privado del perfil.

## Constraints

- No copiar, registrar ni imprimir la URL de conexión con credenciales compartida en la conversación. Rotar esa credencial antes de volver a usarla; configurarla sólo en un `.env` ignorado o en el gestor de secretos del entorno.
- No conectar, migrar, sembrar, truncar ni resetear la base de aplicación compartida durante este trabajo.
- Los tests que pueden borrar/recrear datos requieren `TEST_DATABASE_URL` explícita y una guarda que rechace la misma base/endpoint que `DATABASE_URL`; nunca hacen fallback a la URL de aplicación.
- No asumir que Neon permite `DROP DATABASE`/`CREATE DATABASE` como un PostgreSQL autogestionado. Definir el reset dentro de la base aislada y validarlo sin tocar la DB de aplicación.
- Conservar cobertura de tests y los datos de seed del challenge; no desactivar suites para evitar adaptar su configuración.
- Antes de eliminar scripts/configs, hacer snapshot Git de cambios previos y revisar el diff. No tocar el contrato de API.
- La salida pública debe explicar únicamente el mecanismo de configuración (`DATABASE_URL`) y el requisito de URL aislada para pruebas; no mencionar hosts, passwords ni datos específicos de la máquina.

## Tasks (1–2 archivos por tarea; cada una con verificación)

1. **Inventario y snapshot de cambios**: revisar todos los archivos versionados que configuran, documentan o prueban la DB; separar URLs del servidor HTTP (`localhost:3000`, no DB) de URLs de PostgreSQL. Verificar `git status`, branch y HEAD. No borrar nada hasta tener snapshot seguro.
   - Verificación: inventario de rutas con referencias DB/locales y clasificación app/test/infra/docs; Git status y base registrados.
2. **Config pública de la app**: reemplazar valores sensibles o específicos de host en `.env.example` y documentar que `DATABASE_URL` se configura externamente; nunca agregar la URL real.
   - Verificación: `.env.example` tiene placeholders no secretos; búsqueda sobre archivos trackeados no encuentra URI PostgreSQL ni credenciales reales.
3. **Aislamiento de suites con DB**: definir `TEST_DATABASE_URL` exclusiva; adaptar setup/reset de forma compatible con una DB Neon aislada, con guardas de seguridad contra uso de `DATABASE_URL` de app.
   - Verificación: tests abortan claramente si falta la URL de test o si coincide con la URL de app; ejecutar las suites contra el branch/base dedicado sólo después de verificar host/base y confirmar que no es la DB de aplicación.
4. **Retirar infraestructura específica de desarrollo**: actualizar o retirar compose/scripts/configs de provisionamiento que ya no formen parte del entorno solicitado; limpiar instrucciones y comentarios de `AGENTS.md`, README, docs y tests.
   - Verificación: búsqueda en todos los archivos versionados por patrones de hosts/puertos/nombres y frases específicas de DB local sin resultados; revisar manualmente excepciones legítimas (p. ej. URLs del servidor HTTP y documentación genérica de PostgreSQL).
5. **Consistencia y gates**: actualizar CODEMAP/docs/OpenAPI/test runner si cambian rutas o archivos; ejecutar typecheck, lint, suites unitarias, suite completa y guardias docs/OpenAPI; verificar que no se alteró el contrato ni los golden values del challenge.
   - Verificación: outputs reales de cada comando, git diff revisado y `git status` explicado.

## Abierto antes de ejecutar

- Confirmar/provisionar el branch/base Neon exclusivo para tests y configurar su URL fuera de Git. La URL de aplicación compartida en la conversación no se usa para pruebas ni se copia a archivos.
- Verificar el procedimiento de reset seguro compatible con ese branch Neon antes de tocar `scripts/test-db-reset.sh`; el script actual hace DROP/CREATE DATABASE y no debe ejecutarse contra la URL de aplicación.
