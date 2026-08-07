# Gifted Grads Insurance

> Captura de leads de seguros con formulario Jotform embebido, webhook a
> Cloudflare Workers, asignación de número de participante para rifa de
> gift card y dashboard del manager.
>
> **Stack:** React 18 + TypeScript + Vite + TailwindCSS · Cloudflare Pages + Pages Functions + D1 + Resend.
> **API contract:** [`API.md`](./API.md) · **Migrations:** [`migrations/`](./migrations/)

## Inicio rápido

```bash
npm install

# Dev local: usa mock automáticamente si no configuras VITE_API_BASE_URL.
# Password del manager en mock: "admin".
npm run dev
```

Si quieres forzar el backend real desde Vite, define `VITE_USE_MOCK_API=false` y `VITE_API_BASE_URL`.

Compilación de producción: `npm run build` (sale a `dist/`). Tests: `npm test`.

## Estructura

- `src/` — aplicación React (rutas, componentes, hooks, i18n, cliente API).
- `shared/` — tipos y esquemas zod compartidos entre frontend y Workers.
- `functions/` — Cloudflare Pages Functions (handlers + middleware + helpers).
- `migrations/` — esquema D1, numeradas y aplicadas en orden (`0001_init.sql` … `0011_form_version_source_revision.sql`).
- `wrangler.toml` — configuración de Cloudflare Pages + binding D1.
- `public/_redirects` — fallback SPA para rutas del cliente.

## Acceso administrativo

Cada administrador tiene una **cuenta individual** en la tabla `admin_users`.
No existe contraseña compartida y **no existe registro público de
administradores**: las cuentas solo se crean con el script de bootstrap, que
requiere acceso local al proyecto y a las credenciales de wrangler.

### Crear el primer administrador

```bash
# 1. Aplica las migraciones (incluida 0005_admin_identity.sql)
npx wrangler d1 migrations apply DB --local     # local
npx wrangler d1 migrations apply DB --remote    # producción

# 2. Crea la cuenta (pide la contraseña de forma interactiva, sin eco)
npm run bootstrap:admin -- --email tu@ejemplo.com --name "Tu Nombre"

# Producción: exige confirmar el nombre de la base de datos
npm run bootstrap:admin -- --email tu@ejemplo.com --name "Tu Nombre" --remote

# Sin interacción (CI / scripts): la contraseña va por variable de entorno,
# nunca como argumento de línea de comandos.
ADMIN_BOOTSTRAP_PASSWORD='...' npm run bootstrap:admin -- \
  --email tu@ejemplo.com --name "Tu Nombre" --remote --confirm taketheleed

# Ver qué SQL se ejecutaría, sin escribir nada
npm run bootstrap:admin -- --email tu@ejemplo.com --name "Tu Nombre" --dry-run
```

Si tu wrangler local está roto o desactualizado, apunta a otro con `WRANGLER_CMD`:

```bash
WRANGLER_CMD="npx --yes wrangler@latest" npm run bootstrap:admin -- \
  --email tu@ejemplo.com --name "Tu Nombre" --local
```

El script pasa el SQL a wrangler mediante un **archivo temporal** (`--file`), no
por línea de comandos: así el hash de la contraseña nunca aparece en la lista de
procesos y la sentencia no se rompe al atravesar el shell.

Requisitos: email válido y único (sin distinción de mayúsculas), nombre no
vacío y contraseña de **12 caracteres como mínimo**. Un email duplicado se
rechaza (índice `UNIQUE` sobre `normalized_email`).

### Cómo funciona la sesión

| Aspecto | Comportamiento |
|---|---|
| Login | `POST /api/manager/login` con `{ email, password }` |
| Contraseñas | PBKDF2-HMAC-SHA256 (100 000 iteraciones, salt aleatorio). Nunca en texto plano |
| Token de sesión | 256 bits aleatorios. D1 guarda **solo el SHA-256**; el token viaja en una cookie `HttpOnly; Secure; SameSite=Lax`. En HTTPS usa el prefijo `__Host-`, que impide que un subdominio la sobrescriba |
| CSRF | `SameSite=Lax` + login y logout exigen `Content-Type: application/json` (si no, **415**), lo que bloquea formularios cross-origin |
| Expiración | 12 horas (`SESSION_TTL_MS`, definido una sola vez en `functions/_shared/auth.ts`) |
| Logout | `POST /api/manager/logout` — revoca la sesión en el servidor (`revoked_at`) y expira la cookie |
| Revocación | Una sesión revocada, expirada, o cuyo administrador esté `SUSPENDED`/`DISABLED`, deja de autenticar de inmediato |
| Rate limiting | Persistente en D1, por email y por IP (ambos hasheados): 10 intentos fallidos por ventana de 15 min. El bucket **por IP** bloquea de forma dura; el **por email** solo rechaza contraseñas incorrectas, para que nadie pueda dejar fuera a un administrador legítimo conociendo su correo |

El estado `status` se relee en **cada** petición, así que suspender a un
administrador corta sus sesiones activas sin esperar a que expiren.

> **Impacto de la migración 0005:** las sesiones anteriores no tienen actor y no
> pueden convertirse honestamente en sesiones atribuibles, por lo que la tabla
> `manager_sessions` se elimina. Al desplegar, **todos los managers conectados
> quedan desconectados** y deben iniciar sesión con una cuenta individual.

### Desarrollo local

- **Con mock** (`npm run dev` sin `VITE_API_BASE_URL`): usa las cuentas demo
  listadas en `.env.example`. Existen solo en memoria del navegador.
- **Con D1 real** (`npx wrangler pages dev -- npm run dev`): aplica las
  migraciones en local y crea un admin con `npm run bootstrap:admin`. La cookie
  omite el atributo `Secure` sobre HTTP para que funcione en `localhost`.

## Auditoría y convenciones de datos

### Registro de auditoría

Cada acción administrativa queda registrada en `audit_logs` (migración 0006),
que es **append-only desde la aplicación**: no existe endpoint de UPDATE, DELETE
ni purga, y el repositorio solo expone `append`, `list` y `findById`.

Se consulta en `/manager/audit`, o vía `GET /api/audit` y `GET /api/audit/:id`
(ambos requieren administrador autenticado; no hay acceso público).

| Aspecto | Comportamiento |
|---|---|
| Actor | `actor_admin_id`, **nullable**: un login fallido ocurre antes de que exista actor |
| Borrado de un admin | `ON DELETE SET NULL`, nunca CASCADE — la historia sobrevive aunque la cuenta desaparezca |
| Secretos | Redacción central y recursiva: `password`, `token`, `cookie`, `authorization`, `secret`, `api_key`, IP en claro… se guardan como `[REDACTED]` |
| Enumeración | Un login fallido guarda el correo enmascarado (`a***@dominio`) y siempre el mismo motivo genérico |
| Inundación | Solo se auditan denegaciones cuya sesión **existe** en la BD (revocada, expirada, admin suspendido). Una cookie ausente o desconocida no escribe nada |
| Fallo de auditoría | Login y logout son *best-effort*: si el insert falla se registra en el log estructurado, pero la sesión igual se crea o se revoca |
| Operaciones críticas | `AuditService.statementFor()` devuelve una sentencia para incluir en `db.batch([...])` y que la auditoría *commitee* junto con la operación |

## Eventos

Dominio **nuevo e independiente** (migración 0007). No comparte nada con la
captación de leads heredada: la página pública `/events` y la tabla `attendees`
son otra funcionalidad y siguen intactas.

Se administra en `/manager/events`. La API vive bajo `/api/events` y exige
administrador autenticado.

### Ciclo de vida

```
DRAFT ─┬─> SCHEDULED ─┬─> OPEN ──> CLOSED ──> DRAW_READY ──> ARCHIVED
       ├─> OPEN       ├─> CANCELLED ──> ARCHIVED
       ├─> CANCELLED  └─> ARCHIVED
       └─> ARCHIVED
```

No existe un `PATCH status` genérico: cada movimiento es una acción explícita
(`publish`, `open`, `close`, `mark-draw-ready`, `cancel`, `archive`) con sus
precondiciones, su timestamp y su acción de auditoría.

**No hay transiciones automáticas.** Las fechas son precondiciones y
presentación; el administrador ejecuta cada cambio de estado. Nada corre por
temporizador. La arquitectura queda lista para automatizar más adelante, pero
esta fase no lo introduce.

> **El flujo público de participación todavía no existe.** Abrir un evento es una
> transición administrativa; aún no expone nada a los participantes.

### Reglas clave

| Aspecto | Comportamiento |
|---|---|
| Edición | Se restringe según el estado: el slug se congela al salir de `DRAFT`; en `OPEN` las reglas de participación (edad, límite, timezone, ventana de registro) quedan fijas porque los participantes ya actuaron sobre ellas; tras `CLOSED` solo cambia el contenido editorial; `ARCHIVED` es de solo lectura |
| Concurrencia | Cada evento lleva `revision`. Toda mutación envía `expectedRevision`; si cambió, responde **409 `EVENT_REVISION_CONFLICT`** en vez de sobrescribir en silencio |
| Fechas | Instantes en UTC; `timezone` IANA solo para entrada y presentación. El formulario convierte la hora local del evento a UTC con `Intl`, sin depender de la zona del navegador ni de una librería de fechas |
| Eliminación | Física solo para un borrador **intacto** (sin ningún timestamp operativo). Cualquier otro caso se archiva. El borrado guarda el snapshot completo en auditoría |
| Duplicación | Crea siempre un `DRAFT` nuevo. No copia estado, timestamps operativos ni autor original. Las fechas no se copian salvo `copyDates: true`, y solo las futuras |
| Slug | Único, minúsculas, sin colisionar con rutas reservadas. Se genera del nombre y se auto-sufija; un slug **explícito** nunca se renombra en silencio |
| Atomicidad | La mutación y su auditoría van en el mismo `db.batch()`. Si falla la auditoría, la mutación **se revierte** |

## Premios

Los premios son **configuración de cada evento** (migración 0008), no esquema.
"Vape", "Grinder" o "Gift Card" son filas que crea el cliente: no existen en el
código ni en la base de datos como valores fijos.

Se administran en `/manager/events/:eventId/prizes`, con acceso desde el detalle
del evento.

### Estados

`ACTIVE` cuenta para el sorteo · `INACTIVE` se conserva pero no participa ·
`ARCHIVED` es historia: inmutable, fuera de los listados por defecto y **no
eliminable** (archivar es precisamente el acto de conservarlo).

Los cambios de estado son acciones explícitas (`activate`, `deactivate`,
`archive`). No hay `PATCH status`, y repetir una acción se rechaza con un error
tipado en vez de subir la revisión en silencio.

### Qué permite cada estado del evento

| Estado del evento | Los premios se pueden |
|---|---|
| `DRAFT` / `SCHEDULED` | gestionar por completo |
| `OPEN` | **solo editar contenido** (nombre, descripción, imagen) |
| `CLOSED` / `DRAW_READY` / `DRAW_COMPLETED` | solo leer |
| `CANCELLED` | solo archivar |
| `ARCHIVED` | solo leer |

La regla de `OPEN` es la importante: cuando ya hay gente participando, el
conjunto de premios y el número de unidades son la promesa que se les hizo.
Corregir una errata sigue siendo posible; cambiar lo que se ofrece, no.

### Reglas clave

| Aspecto | Comportamiento |
|---|---|
| Concurrencia | Cada premio lleva su propia `revision`; una mutación obsoleta responde **409 `PRIZE_REVISION_CONFLICT`** |
| Orden | Posición única entre los premios vivos. El reordenamiento envía la lista completa y se aplica en **dos pasadas** dentro de un mismo batch, así que un intercambio nunca colisiona con el índice único |
| Imagen | Solo `http`/`https`; se rechaza `javascript:`, `data:`, `file:` y rutas relativas, tanto al escribir como al leer |
| Eliminación | Solo un premio vivo bajo un evento editable. El resto se archiva. El borrado guarda el snapshot completo en auditoría |
| Atomicidad | Cada mutación y su fila de auditoría van en el mismo `db.batch()` |
| Límite | 100 premios por evento |

### Efecto sobre el evento

- Un evento con **cualquier** premio (activo, inactivo o archivado) ya no se
  puede eliminar: hay que archivarlo. La base de datos lo impone con
  `ON DELETE RESTRICT`.
- `mark-draw-ready` ahora exige al menos un premio `ACTIVE`. Sin él, la
  transición se rechaza y la UI muestra `ACTIVE_PRIZE_REQUIRED` como
  precondición pendiente.

> El total de unidades activas es informativo: determinará cuántas asignaciones
> podrá hacer el futuro sorteo, que todavía no está implementado.

### Convenciones de datos

| Concepto | Formato | Utilidad |
|---|---|---|
| Instante | `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, ancho fijo) | `nowIso()`, `parseStoredTimestamp()`, `assertIsoTimestamp()` |
| Fecha civil | `YYYY-MM-DD`, sin hora ni zona | `isCivilDate()`, `compareCivilDates()` |
| Zona horaria | Identificador IANA; por defecto `America/New_York` | `isValidTimeZone()`, `DEFAULT_TIMEZONE` |
| ID | UUID v4 | `newId()`, `asUuid()` |
| JSON persistido | TEXT validado al leer | `serializeJson()`, `parseJson()` |

Las tablas nuevas generan sus timestamps en la **aplicación**, nunca con
`datetime('now')`: ese valor no lleva zona y rompe el orden lexicográfico del
que dependen las consultas de expiración y de auditoría. El ancho fijo es lo que
permite que `ORDER BY created_at` sea cronológico.

Una fecha civil (un cumpleaños, por ejemplo) **no** se convierte a instante: es
el mismo día en todo el mundo, y pasarla por UTC es exactamente lo que produce el
error clásico de "un día menos".

Para entidades futuras con horario propio: guardar el identificador IANA en una
columna `timezone` y los instantes en UTC. Nunca guardar un desfase numérico —
los desfases cambian con el horario de verano, los identificadores no.

### Notas de operación

`PBKDF2_ITERATIONS` (en `functions/_shared/password.ts`) está fijado en 100 000.
Eso cuesta del orden de 50–100 ms de CPU por login, cómodo dentro del límite del
plan de pago de Cloudflare pero **por encima del techo de 10 ms de CPU del plan
gratuito**. El número de iteraciones se guarda dentro de cada hash, así que
puede ajustarse después sin invalidar las contraseñas existentes.

## Constructor de formularios

Cada evento tiene su propio formulario de registro, y se construye **desde el
panel**: `/manager/events/:id/form`.

El formulario es **datos**, no código. Una pregunta como "¿Fumas?" es una fila,
sus respuestas posibles son filas, y su posición es un número. Añadir una
pregunta nueva nunca requiere una migración, una columna ni un despliegue — que
es exactamente el punto de esta parte del sistema.

El constructor tiene tres paneles: los **pasos** a la izquierda, las
**preguntas** del paso seleccionado en el centro, y las **propiedades** de la
pregunta seleccionada a la derecha. Todo se reordena con botones (subir/bajar)
además de arrastrar, porque arrastrar no funciona con teclado.

**Tipos de pregunta:** texto corto, texto largo, correo, teléfono, fecha,
número, sí/no, opción única, opción múltiple, desplegable, consentimiento e
información. Solo los tres tipos de selección admiten opciones.

**Campos estándar** (nombre, apellido, correo, fecha de nacimiento, teléfono)
se colocan con un clic. Su tipo y su clave de respuesta son fijos para que las
exportaciones sean predecibles, pero su texto, su ayuda y su posición se editan
como cualquier otra pregunta. Cada uno puede aparecer una sola vez.

**Crear el formulario es explícito.** Entrar al constructor no crea nada: si el
evento todavía no tiene formulario, verás un botón para crearlo. Es deliberado
— un evento con formulario ya no se puede eliminar, y eso no debería pasar solo
por visitar una pantalla.

**Borrador y publicación.** Lo que se edita aquí es un BORRADOR: no es lo que
llenan los participantes. Eso es una **versión publicada** (ver el capítulo
siguiente). Por eso el borrador se puede seguir editando incluso con el evento
abierto — se está preparando la próxima versión, no cambiando la actual bajo los
pies de nadie. Desde que el evento cierra, el formulario queda en solo lectura.

**Vista previa.** Muestra el formulario tal como lo encontraría un participante
y lista lo que impediría publicarlo (un paso vacío, una pregunta de opción sin
opciones activas). No guarda nada ni crea ningún participante.

**Edición simultánea.** Todo el formulario comparte una sola revisión. Si otra
persona guarda mientras editas, tu siguiente cambio se rechaza con un aviso en
vez de sobrescribir su trabajo.

## Publicación y versiones del formulario

Publicar **copia**, no promueve. Al publicar, los pasos, preguntas y opciones
del borrador se vuelven a insertar como filas de una **versión congelada**, y el
borrador se queda exactamente donde estaba. Si publicar promoviera el borrador,
editar el formulario mañana reescribiría lo que alguien respondió ayer: la
respuesta dejaría de significar lo que significaba cuando se dio.

Una versión publicada **no se puede modificar ni borrar**. No es una regla de
buena conducta: el repositorio que las maneja solo sabe leer e insertar.

**Publicar no es editar.** El borrador vuelve con la misma revisión con la que
entró, así que quien publica puede seguir escribiendo sin recargar. El aviso de
"hay cambios sin publicar" son dos números comparados, no una marca de tiempo.

**Todo o nada.** La versión, sus filas copiadas, el puntero del evento y el
registro de auditoría se escriben en una sola operación. Nunca existe una
versión a medio copiar, ni un evento apuntando a algo que no terminó de nacer.

**Una versión por revisión.** Una misma revisión del borrador se congela una sola
vez. Publicar dos veces sin haber cambiado nada responde 409 diciendo qué versión
ya la contiene, y dos publicaciones simultáneas no pueden ser ambas la versión 3.

**Qué exige publicar:** nombre, apellido y correo presentes, activos y
obligatorios (y fecha de nacimiento si el evento tiene edad mínima); ningún paso
vacío; ninguna pregunta de selección con menos de dos opciones activas; ninguna
pregunta obligatoria desactivada. El constructor pregunta antes de ofrecer el
botón, con exactamente las mismas reglas con las que el servidor lo rechazaría.

**Sin formulario publicado, el evento no avanza.** Programar y abrir un evento
quedan bloqueados con `PUBLISHED_FORM_REQUIRED` hasta que exista una versión
publicada válida — y "válida" quiere decir *del propio evento y con preguntas*.
El puntero se resuelve, no se cree: SQLite no puede exigir por clave foránea que
la versión apuntada pertenezca a ese evento, así que el servidor lo comprueba en
cada camino que dependa de él. Un puntero que apunte a la versión de otro evento
se registra como error, porque por la API no puede llegar a existir.

**Historial.** El panel lista todas las versiones, la más reciente primero, y
marca cuál se está sirviendo. Cada versión guarda además una copia en JSON que se
compara con las filas al leerla; si no coinciden, la lectura falla en vez de
elegir una — esa discrepancia es la única señal de que algo le pasó a un
formulario que la gente ya llenó.

**Recuperación.** El flujo normal nunca pierde el borrador. Para el caso en que
el borrador se dañe, existe una costura en el servicio que copia una versión
publicada de vuelta a un borrador nuevo. No tiene endpoint a propósito:
recuperar es una decisión deliberada de un operador, no un botón que se pueda
pulsar sin querer.


## Configuración de Jotform

> **Obsoleto:** la integración con Jotform se eliminó del código (commit
> `f0f812e`). El registro público vive ahora en `POST /api/register`, alimentado
> por el formulario multipaso de `/events`. Esta sección se conserva únicamente
> como referencia histórica y no describe el comportamiento actual.

El formulario de registro vive en un Jotform (el toggle ES/EN del header cambia la UI alrededor, pero ambos idiomas embedean el mismo form). Cloudflare Workers solo procesa el webhook que dispara Jotform al recibir cada submission.

### 1. Estructura del formulario

Los 4 campos requeridos. El matcher del webhook strips el prefijo `qN_` y matchea por slug, así que el número de pregunta no importa — solo que el slug/etiqueta del campo coincida con alguno de los aliases definidos en `functions/_shared/jotform.ts`.

| Etiqueta sugerida | Tipo Jotform | Mapea a |
|-------------------|--------------|---------|
| Name | Full Name / Short Text | `nombre` |
| Number | Phone | `telefono` |
| Email | Email | `email` |
| What type of insurance are you interested in? | Dropdown / Radio (`House`, `Auto`, `Life`) | `insuranceType` |

Después de crear el form, copia el Form ID (el número que aparece en `https://form.jotform.com/{ID}`).

### 2. Configurar el formulario

1. **Settings → Thank You Page → Redirect to external link**

   ```
   https://{TU_DOMINIO}/confirmacion?submission={id}
   ```

   Jotform reemplaza `{id}` con el submission ID real. La página de confirmación hace polling al backend hasta que el webhook procesa el registro.

2. **Settings → Integrations → Webhooks**

   ```
   https://{TU_DOMINIO}/api/jotform/webhook/{JOTFORM_WEBHOOK_SECRET}
   ```

   Reemplaza `{JOTFORM_WEBHOOK_SECRET}` con el valor real (genera uno con `openssl rand -hex 32`).

### 3. Ajustar el mapping (si los slugs no coinciden)

El matcher en `functions/_shared/jotform.ts` busca por slug. Si Jotform usó otro slug para algún campo, agrégalo a `FIELD_ALIASES` (lista ordenada de candidatos por campo). Los aliases de opciones de tipo de seguro (House/Auto/Life en ES e EN) están en `INSURANCE_TYPE_MAP`.

Para ver el `rawRequest` real que envía tu form: haz un submission de prueba y revisa el log del worker (`wrangler pages dev` o Cloudflare dashboard → Pages → Functions → Logs). Si la validación falla, el log incluye `rawKeys` con todas las claves que llegaron.

### 4. Configurar variables de entorno

Frontend (`.env`, los defaults en `.env.example` apuntan al form en producción):

```
VITE_JOTFORM_FORM_ID_ES="261465857224059"
VITE_JOTFORM_FORM_ID_EN="261465857224059"
```

Worker (`wrangler.toml` para vars + Cloudflare dashboard para secrets):

```toml
[vars]
JOTFORM_ALLOWED_FORM_IDS = "261465857224059"
RESEND_FROM = "Gifted Grads <noreply@aainsurances.com>"
ORGANIZER_EMAIL = "info@aainsurances.com"
```

```bash
npx wrangler pages secret put JOTFORM_WEBHOOK_SECRET
```

Para dev local: pon todo en `.dev.vars` (copia de `.dev.vars.example`).

## Despliegue en Cloudflare

### 1. Crear la base de datos D1

```bash
npx wrangler d1 create gifted-grads
```

Copia el `database_id` impreso y reemplázalo en `wrangler.toml`.

### 2. Aplicar migraciones

```bash
# Local (para wrangler pages dev)
npx wrangler d1 migrations apply DB --local

# Producción
npx wrangler d1 migrations apply DB --remote
```

### 3. Configurar secretos

```bash
npx wrangler pages secret put RESEND_API_KEY
```

> `MANAGER_PASSWORD` ya **no se usa**. El acceso administrativo dejó de depender
> de una contraseña compartida; cada administrador tiene una cuenta individual.
> Si el secreto sigue configurado en Cloudflare, puedes eliminarlo:
> `npx wrangler pages secret delete MANAGER_PASSWORD`.

Para desarrollo local, copia `.dev.vars.example` a `.dev.vars` y rellena los valores.

### 4. Desarrollo local contra el Worker real

```bash
npx wrangler pages dev -- npm run dev
```

### 5. Deploy

Conecta el repositorio a Cloudflare Pages:
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Functions directory:** `functions` (autodetectado)
- **Compatibility flags:** `nodejs_compat`

## Variables de entorno

### Frontend (build-time, prefijo `VITE_`)

- `VITE_API_BASE_URL` — vacío para mismo origen (Pages Functions).
- `VITE_USE_MOCK_API` — `"true"` activa el mock in-memory; `"false"` lo desactiva. En `npm run dev`, si no hay `VITE_API_BASE_URL`, el mock se activa automáticamente.
- `VITE_JOTFORM_FORM_ID_ES` — Form ID del formulario en español.
- `VITE_JOTFORM_FORM_ID_EN` — Form ID del formulario en inglés.

### Worker

| Nombre | Tipo | Notas |
|--------|------|-------|
| `DB` | D1 binding | Definido en `wrangler.toml`. Aplicar `migrations/*.sql`. |
| `RESEND_API_KEY` | Secret | API key de Resend. |
| `JOTFORM_WEBHOOK_SECRET` | Secret | Secret embebido en la URL del webhook de Jotform. |
| `RESEND_FROM` | Var (en `wrangler.toml`) | Remitente verificado en Resend. |
| `ORGANIZER_EMAIL` | Var (en `wrangler.toml`) | `onelio@aaservices.com`. |
| `JOTFORM_ALLOWED_FORM_IDS` | Var (en `wrangler.toml`) | CSV con los dos Form IDs aceptados. |

---

## Descripción del proyecto

Gifted Grads Events será una aplicación web diseñada para registrar, organizar y administrar la información de las personas que asistirán a un evento. La plataforma tendrá como objetivo facilitar el proceso de inscripción, centralizar los datos de los asistentes, mostrar métricas en tiempo real y automatizar el proceso de una rifa al finalizar el evento.

Se estima que aproximadamente **200 personas** se registrarán en la aplicación.

## Registro de asistentes

La aplicación deberá contar con una sección de registro donde cada persona pueda completar un formulario con su información personal. Este formulario puede incluir datos como:

- Nombre completo
- Correo electrónico
- Número de teléfono
- Género
- Edad
- Institución o universidad
- Carrera o área de estudio
- Nivel académico
- Cualquier otro dato necesario para la organización del evento

Una vez que la persona complete el formulario, el sistema deberá guardar su información de forma segura y confirmar que el registro fue realizado correctamente.

## Asignación de número de participante

Al momento de registrarse, cada persona deberá recibir automáticamente un número único de participante. Este número servirá para identificar al asistente dentro del evento y también será utilizado para una rifa especial que se realizará después del evento.

Por ejemplo, si una persona se registra, el sistema puede asignarle el número `001`, a la siguiente persona el `002`, y así sucesivamente hasta completar todos los registros.

## Envío de información por correo

Cada vez que una persona complete su registro, la información deberá enviarse automáticamente al correo electrónico:

**onelio@aaservices.com**

Este correo deberá incluir los datos principales del asistente, junto con su número único de participante, para que el equipo organizador tenga una copia del registro.

## Panel administrativo para el manager

La aplicación también deberá incluir un panel administrativo para el manager. Desde este panel, el manager podrá ver en tiempo real la información de todas las personas registradas.

El dashboard deberá permitir:

- Ver la lista completa de asistentes registrados
- Revisar la información personal de cada participante
- Ver el número asignado a cada persona
- Buscar asistentes por nombre, correo o número de participante
- Confirmar que una persona se registró correctamente
- Ver el total de personas inscritas
- Monitorear métricas importantes del evento

## Métricas actualizadas en tiempo real

El dashboard del manager deberá mostrar estadísticas que se actualicen automáticamente cada vez que una nueva persona se registre.

Algunas métricas que puede mostrar son:

- Total de personas registradas
- Porcentaje de participantes por género
- Cantidad de hombres y mujeres registrados
- Porcentaje por carrera o área de estudio
- Porcentaje por institución o universidad
- Promedio de edad de los asistentes
- Cantidad de registros completados

Por ejemplo, si el 50% de las personas registradas son mujeres, esa información deberá mostrarse automáticamente en el dashboard. Si luego se registra otra persona, el porcentaje deberá actualizarse en vivo sin necesidad de recargar la página.

## Rifa del gift card

Después del evento, se realizará una rifa entre las personas registradas. Como cada participante tendrá un número único asignado, el sistema deberá permitir seleccionar un número ganador.

La persona que tenga el número ganador recibirá un **gift card** como premio.

El manager deberá poder realizar o registrar la rifa desde el panel administrativo. Una vez seleccionado el número ganador, la aplicación deberá identificar automáticamente a la persona asociada a ese número.

## Notificación al ganador

Cuando se seleccione el número ganador de la rifa, el sistema deberá enviar automáticamente un correo electrónico a la persona ganadora, notificándole que ganó el gift card.

El correo deberá incluir un mensaje de felicitación y la información necesaria para reclamar el premio.

## Objetivo principal de la aplicación

El objetivo principal de Gifted Grads Events es crear una plataforma moderna y eficiente para manejar el registro de asistentes a un evento. La aplicación permitirá recopilar información personal, asignar números únicos de participación, enviar registros por correo, mostrar datos en tiempo real al manager y automatizar el proceso de selección y notificación del ganador de la rifa.

En resumen, la aplicación deberá ayudar al equipo organizador a tener un mejor control del evento, reducir procesos manuales, confirmar registros fácilmente y ofrecer una experiencia más organizada tanto para los asistentes como para el manager.

## Resumen funcional del sistema

Gifted Grads Events deberá incluir dos áreas principales:

### 1. Aplicación para asistentes

En esta parte, los usuarios podrán registrarse llenando un formulario con su información personal. Al completar el registro, recibirán un número único de participante que será utilizado para la rifa del gift card.

### 2. Aplicación o dashboard para el manager

En esta parte, el manager podrá ver todos los registros en tiempo real, revisar la información de los asistentes, consultar métricas actualizadas, buscar participantes y gestionar la rifa del gift card.

## Flujo general de la aplicación

1. El asistente entra a la aplicación web.
2. Completa el formulario con su información personal.
3. El sistema guarda el registro.
4. El sistema asigna automáticamente un número único de participante.
5. La información del asistente se envía al correo `onelio@aaservices.com`.
6. El registro aparece automáticamente en el dashboard del manager.
7. Las métricas del dashboard se actualizan en tiempo real.
8. Después del evento, el manager realiza la rifa.
9. El sistema selecciona o registra el número ganador.
10. La aplicación identifica al ganador.
11. El ganador recibe una notificación por correo electrónico informándole que ganó el gift card.
