# API Contract — Gifted Grads Events

This document is the source of truth for the HTTP API consumed by the React frontend. The frontend (under `src/`) makes typed `fetch` calls against these endpoints via `src/lib/api.ts`. The Worker / Pages Functions implementations live under `functions/api/` and must match these shapes exactly.

All endpoints:
- Live at the same origin as the SPA (Cloudflare Pages Functions).
- Send/receive JSON (`Content-Type: application/json`).
- Encode all dates as ISO 8601 UTC strings.

## Error envelope

Any non-2xx response should return:

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable",
    "fields": { "email": "..." }
  }
}
```

`fields` is optional and only used for `VALIDATION_ERROR`.

Codes the frontend reacts to:
- `VALIDATION_ERROR` (400)
- `EMAIL_EXISTS` (409)
- `INVALID_CREDENTIALS` (401)
- `UNAUTHORIZED` (401)
- `SESSION_INVALID` / `SESSION_EXPIRED` / `SESSION_REVOKED` (401)
- `ADMIN_SUSPENDED` / `ADMIN_DISABLED` (401 on a protected route, 403 on login)
- `NOT_FOUND` (404)
- `WINNER_NOT_FOUND` (404)
- `NO_ATTENDEES` (400)
- `RAFFLE_ALREADY_DRAWN` (409, optional)
- `RATE_LIMIT` (429)
- `SERVER_ERROR` (500)

## Authentication

Administrators are **individual accounts** (`admin_users`). The shared
`MANAGER_PASSWORD` flow was removed; the variable is no longer read anywhere.

1. Frontend calls `POST /api/manager/login` with `{ email, password }`.
2. The Worker normalizes the email, looks up `admin_users.normalized_email`, and
   verifies the password against `password_hash` (PBKDF2-HMAC-SHA256, random
   salt, iteration count embedded in the stored value). A verification is run
   even for an unknown email so response timing does not disclose whether the
   account exists.
3. Status is checked **after** the password matches: `SUSPENDED` → 403
   `ADMIN_SUSPENDED`, `DISABLED` → 403 `ADMIN_DISABLED`.
4. On success: a 256-bit random token is generated; `admin_sessions` stores only
   its **SHA-256** together with `admin_user_id`, `expires_at` (now + 12h),
   `user_agent` and a hashed IP. `last_login_at` is updated.
5. The token is returned **only** in a `Set-Cookie` header:
   `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`. Over HTTPS the
   cookie is named `__Host-l33d_admin_session`; the `__Host-` prefix makes
   browsers refuse to let a sibling subdomain set it, which blocks cookie-tossing
   session fixation. `__Host-` requires `Secure`, so over plain HTTP
   (`wrangler pages dev`) the unprefixed name `l33d_admin_session` is used
   instead. The SPA never sees the token and stores nothing.
   If the same cookie name arrives more than once, the request is treated as
   unauthenticated rather than guessing which value to trust.
6. `_middleware.ts` reads the cookie on every protected route, resolves it to an
   administrator, and publishes the actor on `ctx.data.admin`
   (`{ id, email, displayName, role, status, sessionId }`).

A session stops authenticating the moment it is revoked, expires, or its owner
becomes `SUSPENDED`/`DISABLED` — `status` is re-read on every request.

**CSRF:** two independent controls.
1. The cookie is `SameSite=Lax`, so browsers withhold it from cross-site POST
   requests, which covers every state-changing endpoint.
2. `POST /api/manager/login` and `POST /api/manager/logout` require
   `Content-Type: application/json` and answer **415 `UNSUPPORTED_MEDIA_TYPE`**
   otherwise. A cross-origin HTML form can only send `urlencoded`,
   `multipart` or `text/plain`, and cannot set a JSON content type without a
   CORS preflight this API never approves. Without this, a forged cross-site
   form post could log a victim's browser into the **attacker's** account
   (session fixation), because `Request.json()` parses a body regardless of its
   declared type.

The SPA and the API are same-origin.

Protected endpoints (require a valid session cookie):
- `GET /api/manager/me`
- `POST /api/manager/logout`
- `GET /api/attendees`
- `GET /api/attendees/:id`
- `GET /api/metrics`
- `POST /api/raffle/draw`
- `GET /api/raffle/current`

Public endpoints:
- `POST /api/register`
- `POST /api/manager/login`

Administrator accounts are created only by `npm run bootstrap:admin` (see
README). **There is no public endpoint that creates administrators.**

## Request correlation

Every response carries `X-Request-ID`. The value comes from Cloudflare's
`CF-Ray` when present, otherwise a client-supplied `X-Request-ID` (accepted only
when it matches `^[A-Za-z0-9_-]{1,64}$` — anything else is discarded to prevent
log injection), otherwise a freshly generated UUID.

The same id appears in the audit row, in the server log line and in the body of
any error response, so a user quoting it pins down exactly one request:

```json
{ "error": { "code": "INVALID_QUERY", "message": "…", "requestId": "…" } }
```

`requestId` is optional and additive — existing consumers are unaffected.

## Payload limits

`POST` endpoints require `Content-Type: application/json` and enforce a size
ceiling. The declared `Content-Length` is rejected first, then the ACTUAL byte
count, so a header that understates the body gains nothing.

| Endpoint group | Limit |
|---|---|
| Auth (`/api/manager/login`, `/api/manager/logout`) | 16 KB |
| Administrative JSON | 128 KB |
| Public form (reserved for a later phase) | 256 KB |

Errors: `415 UNSUPPORTED_MEDIA_TYPE`, `413 PAYLOAD_TOO_LARGE`,
`400 INVALID_JSON`. Bodies are parsed with a reviver that strips `__proto__`,
`constructor` and `prototype`.

---

## Audit trail

`audit_logs` is **append-only through the application**: there is no `PUT`,
`PATCH` or `DELETE` for this resource, and `AuditRepository` exposes only
`append`, `list` and `findById`.

Every entry records the actor (nullable — a failed login happens before any
actor exists), the action, the entity, the request id, a hashed IP and a
timestamp. Payloads (`previousData`, `newData`, `metadata`) pass through central
recursive redaction, so `password`, `token`, `cookie`, `authorization`,
`secret`, `api_key`, raw IPs and similar keys are stored as `[REDACTED]`
regardless of what the caller passed.

Audited today: `ADMIN_LOGIN_SUCCEEDED`, `ADMIN_LOGIN_FAILED`, `ADMIN_LOGOUT`,
`ADMIN_ACCESS_DENIED`, `AUDIT_LOG_VIEWED`. Action and entity vocabularies for
later phases are declared but not yet emitted.

**Failed logins never enable enumeration**: the email is masked
(`a***@example.com`) and the reason is the same generic value whether the
account exists or not.

**Access denials are bounded**: only a session that genuinely EXISTS in the
database (revoked, expired, or owned by a suspended/disabled admin) produces a
row. A missing or unrecognised cookie writes nothing, so the table cannot be
flooded by unauthenticated traffic.

**Audit failures never break security actions.** Login and logout use
best-effort auditing: a failed insert is reported through the structured logger
and is invisible to the client, but the session is still created or revoked.
Operations where "it happened but was not recorded" is unacceptable use
`AuditService.statementFor()`, which returns a statement for inclusion in a
`db.batch([...])` so the audit row commits atomically with the operation.

### `GET /api/audit` — auth

Query params: `page`, `pageSize` (max 200), `actorAdminId`, `action`,
`entityType`, `entityId`, `eventId`, `from`, `to`.

`from`/`to` accept a civil date (`YYYY-MM-DD`, widened to cover the whole day)
or a full ISO instant. Ids must be UUIDs; `action` and `entityType` must come
from the published vocabularies. An invalid filter is `400 INVALID_QUERY`
rather than a silently ignored filter.

**Response 200:** `{ items, page, pageSize, total, totalPages }`, newest first.

This endpoint is deliberately NOT audited — one row per page view would let
routine browsing inflate the table without bound.

**Pagination semantics — read this before relying on a traversal.**

Ordering is `created_at DESC, id DESC`. The `id` tiebreak is what makes paging
correct when several rows share a millisecond: without it, equal keys could be
ordered differently per query and a row could repeat or vanish between pages.

That is the **only** stability guarantee. This is offset pagination, so rows
arriving between two page requests shift the window: because the order is
newest-first, new entries push everything down and page 2 can re-show entries
already seen on page 1. **No row is lost from the table** — the traversal simply
is not a consistent snapshot.

To traverse stably, pin the upper bound with `to` (e.g. the timestamp of the
first page load). Cursor pagination was not introduced: the contract is
page-based, audit volume is low, and the failure mode is a repeated row rather
than a missing one.

### `GET /api/audit/:id` — auth

**Response 200:** a single `AuditLog`. **404** `NOT_FOUND` when unknown,
**400** `INVALID_QUERY` when the id is not a UUID.

Records `AUDIT_LOG_VIEWED` — except when the entry being viewed is itself an
`AUDIT_LOG_VIEWED`, which would otherwise let an operator create an endless
chain of view-of-a-view records.

---

## Events

A **new domain**, unrelated to the legacy lead capture that happens to live at
the public `/events` page and in the `attendees` table. Nothing is shared.

All endpoints require an authenticated administrator, answer with typed errors,
send `Cache-Control: no-store` and an `X-Request-ID`, and audit every mutation.

### Lifecycle

```
DRAFT ─┬─> SCHEDULED ─┬─> OPEN ──> CLOSED ──> DRAW_READY ──┐
       ├─> OPEN       ├─> CANCELLED                        │
       ├─> CANCELLED  └─> ARCHIVED                DRAW_COMPLETED
       └─> ARCHIVED                                        │
                        CANCELLED ──> ARCHIVED  <──────────┘
```

There is **no generic `PATCH status`**. Each move is an explicit action with its
own preconditions, timestamp and audit entry. There are also **no automatic
transitions**: dates are preconditions and presentation, and an administrator
performs every state change. Nothing runs on a timer.

`DRAW_COMPLETED` is part of the contract but unreachable until a later phase
introduces draws. `ARCHIVED` is terminal.

**The public participation flow does not exist yet.** Opening an event is an
administrative transition; it does not yet expose anything to the public.

### Editability by state

| State | What may change |
|---|---|
| `DRAFT` | Everything, including the slug |
| `SCHEDULED` | Everything except the slug |
| `OPEN` | Name and editorial copy only — age, entry limit, timezone and the registration window are frozen because participants already acted on them |
| `CLOSED` / `DRAW_READY` / `DRAW_COMPLETED` | Editorial copy only |
| `CANCELLED` | Messages only |
| `ARCHIVED` | Nothing (read-only) |

### Optimistic concurrency

Every event carries a `revision`. Mutations send `expectedRevision`; the update
matches on it and increments it. A stale writer matches zero rows and receives
**409 `EVENT_REVISION_CONFLICT`** instead of silently overwriting the change it
never saw. Transitions and deletes accept `expectedRevision` optionally and
enforce it when given.

### Dates

Stored as UTC instants; `timezone` is an IANA identifier used for entry and
display. Rules, applied only to pairs where both values are present (a draft may
be incomplete):

```
registration_opens_at  <  registration_closes_at
starts_at              <  ends_at
registration_opens_at  <= starts_at
registration_closes_at <= ends_at
```

`SCHEDULED` additionally requires all four dates plus a timezone; `OPEN`
requires a closing date and an event window (opening immediately IS the
opening).

**Timing preconditions.** The rules above say the dates agree with each *other*;
these say they still agree with *now*. Scheduling an event whose registration
opening has already passed, or opening registration that has already closed or
whose event has already ended, is refused with **409 `EVENT_NOT_READY`** (the
`fields.stale` list names the offending dates). `GET /api/events/:id` reports
the same condition under `blockedActions`, so the UI never offers a button the
server will reject.

**Entering times in the admin UI.** Wall-clock input is interpreted in the
EVENT's timezone, never the browser's, and verified by rendering the result
back. Two consequences:

* A time that does not exist is **rejected**. On the spring-forward night New
  York jumps 02:00 → 03:00, so 02:30 is refused rather than silently stored as
  01:30.
* An ambiguous time is **accepted as the first occurrence**. On the fall-back
  night 01:30 happens twice; the earlier (still daylight-time) instant is
  chosen, which is what "1:30 that morning" means. The value round-trips, so
  re-opening the form shows the same wall clock.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/events` | `page`, `pageSize` (≤200), `status`, `search`, `archived` (`active`\|`archived`\|`all`), `sort` (`createdAt`\|`updatedAt`\|`name`\|`startsAt`), `direction`. Archived excluded by default. An invalid filter is **400 `INVALID_QUERY`**, never ignored |
| `POST` | `/api/events` | Creates a `DRAFT`. Only `name` is required |
| `GET` | `/api/events/:id` | Event + `availableActions`, `blockedActions` (with missing fields), `editableFields`, `canDelete`, actor names |
| `PATCH` | `/api/events/:id` | Partial; requires `expectedRevision`; rejects unknown fields and `status` |
| `DELETE` | `/api/events/:id` | Physical delete, **pristine drafts only**. `?expectedRevision=` optional; when present it must be a positive integer, otherwise **400 `INVALID_QUERY`** — a malformed guard is refused, never ignored |
| `POST` | `/api/events/:id/duplicate` | New `DRAFT`. Dates are not copied unless `copyDates: true`, and then only future ones |
| `POST` | `/api/events/:id/{publish,open,close,mark-draw-ready,cancel,archive}` | Transition. **Body may be omitted entirely**; when sent it must be JSON and may carry `expectedRevision` |

### Deletion vs archiving

Physical deletion requires `DRAFT` **and** no operational timestamps: an event
that was ever published, opened, closed or cancelled can only be archived. The
delete writes the full snapshot into `previous_data`, so the audit row becomes
the only remaining evidence the event existed.

Archiving keeps everything, sets `archived_at`, and drops the event out of
active listings.

### Atomicity

Event mutations use the **critical** audit policy: the change and its audit row
commit in one `db.batch()`. If the audit insert fails, the mutation rolls back —
an event cannot change without a record of who changed it. (This is the opposite
of the best-effort policy used for login/logout, where refusing to sign someone
out because of a logging failure would be worse.)

Audit actions emitted: `EVENT_CREATED`, `EVENT_UPDATED`, `EVENT_PUBLISHED`,
`EVENT_OPENED`, `EVENT_CLOSED`, `EVENT_MARKED_DRAW_READY`, `EVENT_CANCELLED`,
`EVENT_ARCHIVED`, `EVENT_DELETED`, `EVENT_DUPLICATED`.

### Slugs

Lowercase ASCII letters, digits and single hyphens; unique; never a reserved
route (`api`, `manager`, `admin`, `events`, `login`, `audit`, …). Generated from
the name and auto-suffixed on collision; an **explicitly supplied** slug is never
silently renamed — it returns **409 `EVENT_SLUG_EXISTS`**, because the public
address is the operator's decision.

---

## Event prizes

Prizes are **configuration owned by an event**, not schema. "Vape", "Grinder"
and "Gift Card" are rows a client creates; nothing in the code or the database
knows those names.

All endpoints are nested under the event, so every lookup is scoped to it and a
prize id from another event resolves to **404**, never to someone else's row.

### Status

`ACTIVE` counts toward the draw · `INACTIVE` is kept but excluded ·
`ARCHIVED` is history: immutable, excluded from listings by default, and not
deletable — archiving is the act of keeping it.

Status changes are explicit actions (`activate`, `deactivate`, `archive`).
There is no `PATCH status`, and repeating an action is a typed refusal rather
than a silent revision bump.

### What the EVENT's state permits

| Event state | Prizes may be |
|---|---|
| `DRAFT` / `SCHEDULED` | fully managed — create, edit, reorder, activate, deactivate, archive, delete |
| `OPEN` | **editorial edits only** (name, description, image) |
| `CLOSED` / `DRAW_READY` / `DRAW_COMPLETED` | read-only |
| `CANCELLED` | archived only |
| `ARCHIVED` | read-only |

The `OPEN` rule is the important one: once people can enter, the SET of prizes
and the NUMBER of units are the offer made to them. A typo fix stays possible;
changing what is on the table does not.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/events/:id/prizes` | `page`, `pageSize` (≤200), `status`, `archived`, `search`, `sort` (`sortOrder`\|`name`\|`quantity`\|`createdAt`\|`updatedAt`), `direction`. Returns `summary` and `eventStatus`. Archived excluded by default |
| `POST` | `/api/events/:id/prizes` | Creates an `ACTIVE` prize at revision 1, appended to the end |
| `GET` | `/api/events/:id/prizes/:prizeId` | Prize + `allowedActions`, `editableFields`, `canDelete`, `eventStatus` |
| `PATCH` | `/api/events/:id/prizes/:prizeId` | Requires `expectedRevision`. Only name, description, imageUrl, quantity |
| `DELETE` | `/api/events/:id/prizes/:prizeId` | Live prizes under an editable event only. `?expectedRevision=` optional; when present it must be a positive integer, otherwise **400 `INVALID_QUERY`** — a malformed guard is refused, never ignored |
| `POST` | `/api/events/:id/prizes/:prizeId/{activate,deactivate,archive}` | Body may be omitted |
| `POST` | `/api/events/:id/prizes/reorder` | Complete new ordering, atomic |

### Image URLs

Optional, and restricted to `http:`/`https:`. `javascript:`, `data:`, `file:`
and relative values are rejected at the schema, and a stored non-http value is
also refused by the mapper on read — so nothing that reaches an `<img src>` can
have arrived from a scheme the browser would execute. No upload or storage
exists yet; the URL is typed in.

### Reordering

The payload must list **every live prize** of the event, each with its own
`expectedRevision`. There is no `expectedEventRevision`: reordering prizes does
not change the event, so guarding on the event's revision would let an unrelated
edit invalidate a pending reorder.

Positions are unique among non-archived prizes (a partial unique index).
Because SQLite checks uniqueness per statement, the reorder writes in **two
passes** inside one batch — parking every prize in a high range no real position
can occupy, then settling the final values. Revisions are verified *before* the
batch, so the ordinary stale-client case never writes anything.

That pre-check cannot close the window between itself and the batch, so a
**guard statement sits between the two passes**: if any prize failed to park —
because another writer moved it in the meantime — the guard aborts the batch and
the transaction rolls back whole. A lost race therefore commits *nothing*: no
moved positions, no bumped revisions and no audit row, and the caller is
answered with **409 `PRIZE_REORDER_CONFLICT`** rather than a partial reorder or
an internal error.

One audit row per operation (`PRIZES_REORDERED`, entity `EVENT`), not one per
prize: the change is collective.

### Deletion vs archiving

Physical deletion requires a live prize under an editable event with no
assignments. Everything else is archived. The delete writes the full snapshot
into `previous_data`, so the audit row becomes the only remaining evidence.

### Effect on the event

* An event holding **any** prize — active, inactive or archived — can no longer
  be deleted (`EVENT_CANNOT_BE_DELETED`); it must be archived. The database
  enforces this too via `ON DELETE RESTRICT`.
* `mark-draw-ready` now requires at least one `ACTIVE` prize with a unit total
  of 1 or more. Without it the transition is refused with **409
  `EVENT_NOT_READY`** and `ACTIVE_PRIZE_REQUIRED` among the blocking fields.

Audit actions emitted: `PRIZE_CREATED`, `PRIZE_UPDATED`, `PRIZE_ACTIVATED`,
`PRIZE_DEACTIVATED`, `PRIZE_ARCHIVED`, `PRIZE_DELETED`, `PRIZES_REORDERED`.
Every prize mutation commits atomically with its audit row.

### Prize error codes

`PRIZE_NOT_FOUND` (404), `PRIZE_EVENT_NOT_EDITABLE` (409),
`PRIZE_CANNOT_BE_EDITED` (409), `PRIZE_INVALID_STATUS` (409),
`PRIZE_ALREADY_ARCHIVED` (409), `PRIZE_CANNOT_BE_DELETED` (409),
`PRIZE_LIMIT_REACHED` (409), `PRIZE_REVISION_CONFLICT` (409),
`PRIZE_REORDER_CONFLICT` (409), `PRIZE_ORDER_INVALID` (400).

---

## Registration forms — auth

The form is **data**. There is no column named after any question a client asks:
a question is a row in `form_questions`, its choices are rows in
`form_question_options`, and its position is an integer. Adding "Do you smoke?"
to a form is a `POST`, never a migration.

The **DRAFT** is the working copy. What a participant fills in is never the
draft but a frozen **VERSION** copied from it — see *Publishing and versions*
below. `form_owner_type` distinguishes the two, so publishing copies rows rather
than migrating a table.

### Reading never writes

`GET` returns `"draft": null` until the form is created; bringing one into
existence is a `POST` an operator makes on purpose. A GET that created a draft
could be fired by a browser prefetch, a double render or a link preview — and
here that accident would write an audit row AND make the event undeletable,
because `event_form_drafts.event_id` is `ON DELETE RESTRICT`. Two simultaneous
`POST`s produce one form and no error: the unique key decides, and the loser
reads the winner's row.

### One revision for the whole form

`event_form_drafts.revision` is the only optimistic-concurrency token. A step, a
question and an option are all edits to ONE document, so every mutation carries
`expectedRevision` for the FORM and moves it by one. Two administrators in the
same builder are editing the same thing; a per-row token would let their changes
interleave into an arrangement neither of them designed.

Each mutation commits as a single batch: the guarded revision bump, an abort
statement that takes the batch down if that bump matched nothing, the mutation,
and its audit row. A stale editor therefore changes **nothing** and is answered
**409 `FORM_REVISION_CONFLICT`**.

Every mutation answers with the **whole draft** at its new revision, so a client
replaces rather than merges.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/events/:id/form` | The draft, or `"draft": null` when there is not one yet. **Never creates** |
| `POST` | `/api/events/:id/form` | Creates the form. **Idempotent** — a second call returns the same one |
| `PUT` | `/api/events/:id/form` | An explicit checkpoint. Records intent and moves the revision |
| `POST` | `/api/events/:id/form/preview` | Renders the draft and reports its problems. Stores nothing, and **404s** rather than creating one |
| `POST` | `/api/events/:id/form/steps` | Add a page |
| `PATCH` / `DELETE` | `/api/events/:id/form/steps/:stepId` | Delete only when the step is **empty** |
| `POST` | `/api/events/:id/form/steps/reorder` | Complete new page order |
| `POST` | `/api/events/:id/form/questions` | A type and a label; options may be created with it |
| `PATCH` / `DELETE` | `/api/events/:id/form/questions/:questionId` | `stepId` in a patch moves the question to the end of that step |
| `POST` | `/api/events/:id/form/questions/:questionId/duplicate` | Copies the question and its choices |
| `POST` | `/api/events/:id/form/questions/reorder` | Complete order **within one step** |
| `POST` | `/api/events/:id/form/questions/:questionId/options` | Add a choice |
| `PATCH` / `DELETE` | `/api/events/:id/form/questions/:questionId/options/:optionId` | |
| `POST` | `/api/events/:id/form/questions/:questionId/options/reorder` | Complete order within one question |

`DELETE` carries `{ "expectedRevision": n }` in the body — the guard is not
optional here, because the form has one revision and a delete without it could
act on an arrangement that has already moved on.

### Question types

`SHORT_TEXT`, `LONG_TEXT`, `EMAIL`, `PHONE`, `DATE`, `NUMBER`, `YES_NO`,
`SINGLE_SELECT`, `MULTI_SELECT`, `DROPDOWN`, `CONSENT`, `INFORMATION`.

Only the three select types take options. `INFORMATION` is copy, not a question:
it can be neither required nor exported, and the column CHECK says so too.
Validation keys are per type — a `minSelected` on an `EMAIL` is refused with
**400 `FORM_QUESTION_INVALID`**. There is deliberately **no regular-expression
rule**: a client-supplied pattern would be evaluated against every submission,
which is a denial of service waiting for a later phase to inherit.

### System fields

`FIRST_NAME`, `LAST_NAME`, `EMAIL`, `DATE_OF_BIRTH`, `PHONE` — and `NONE`, which
every custom question carries. A marked question is still an ordinary row; the
marker exists so later phases can find "the email question" without guessing
from a label.

Each is pinned to a type and a key, may appear **once** per form (a partial
unique index enforces it), and its `type`, `key` and marker cannot be patched.
Its label, help text, requiredness, order and step remain editable. A system
field that is **required** cannot be deleted until it is no longer required.

### Reordering

Every reorder submits the COMPLETE list for its scope, and uses the same
two-pass-with-guard technique as the prize reorder: park every row above any
reachable position, abort the batch if a single one failed to park, then settle.
A lost race commits nothing.

### Preview

`POST .../preview` renders the draft as a participant would meet it — active
questions, active options, placeholders, requiredness, validation — and returns
the `problems` publishing will later refuse (`NO_STEPS`, `EMPTY_STEP`,
`NO_ACTIVE_QUESTIONS`, `SELECT_WITHOUT_OPTIONS`, `REQUIRED_QUESTION_INACTIVE`).
It creates no participant, accepts no answer and writes no row.

### Effect on the event

* The form can be edited while the event is `DRAFT`, `SCHEDULED` or `OPEN` — the
  draft is not what anyone is filling in. From `CLOSED` onwards it is read-only
  (**409 `FORM_NOT_EDITABLE`**).
* An event carrying a form draft joins prizes in being undeletable
  (`EVENT_CANNOT_BE_DELETED`); `event_form_drafts.event_id` is `ON DELETE
  RESTRICT`.

Audit actions emitted: `FORM_DRAFT_CREATED`, `FORM_DRAFT_UPDATED`,
`FORM_STEP_CREATED`, `FORM_STEP_UPDATED`, `FORM_STEP_DELETED`,
`FORM_STEPS_REORDERED`, `FORM_QUESTION_CREATED`, `FORM_QUESTION_UPDATED`,
`FORM_QUESTION_DELETED`, `FORM_QUESTIONS_REORDERED`, `FORM_OPTION_CREATED`,
`FORM_OPTION_UPDATED`, `FORM_OPTION_DELETED`, `FORM_OPTIONS_REORDERED`.

### Form error codes

`FORM_DRAFT_NOT_FOUND` (404), `FORM_STEP_NOT_FOUND` (404),
`FORM_QUESTION_NOT_FOUND` (404), `FORM_OPTION_NOT_FOUND` (404),
`FORM_NOT_EDITABLE` (409), `FORM_REVISION_CONFLICT` (409),
`FORM_STEP_NOT_EMPTY` (409), `FORM_QUESTION_PROTECTED` (409),
`FORM_KEY_EXISTS` (409), `FORM_SYSTEM_FIELD_EXISTS` (409),
`FORM_LIMIT_REACHED` (409), `FORM_QUESTION_INVALID` (400),
`FORM_OPTION_NOT_ALLOWED` (400), `FORM_ORDER_INVALID` (400).

### Answer keys

Lowercase snake_case, unique per form, starting with a letter. Three names are
**reserved** and refused: `__proto__`, `constructor` and `prototype`. An answer
set is naturally a plain object keyed by these values, and those three do not
behave like ordinary keys on one. A key is chosen once and used forever by
whatever consumes answers later, so the rule lives in the domain — not only in
the schema at the edge — and key derivation from a label skips them too (a
question labelled "Constructor" becomes `constructor_2`).

### The polymorphic seam

`form_owner_type` / `form_owner_id` cannot carry a foreign key: the referent
depends on the type. The coherence a key would have guaranteed is therefore
checked **on read** — every question of a form must sit in a step of that form —
and a row that breaks it raises a controlled error naming the column rather than
quietly vanishing from the builder. A question nobody can see is a question
nobody can fix.

## Publishing and versions — auth

Publishing **copies**; it never promotes. The draft's steps, questions and
options are inserted again as `VERSION`-owned rows, and the draft keeps every
row it had. Promoting would mean that editing the form tomorrow rewrites what
somebody answered yesterday — an answer would stop meaning what it meant when it
was given. Immutability is structural rather than by convention:
`FormVersionRepository` exposes reads and `INSERT`s and has no method that could
`UPDATE` or `DELETE` a version.

### Publishing is not an edit

`POST .../publish` carries `{ "expectedRevision": n }` and **nothing else**: the
server publishes the draft it already holds, so a large body never crosses the
wire and nobody can publish something other than what is stored.

The draft comes back at the **same** revision it went in with. An operator who
publishes and then keeps typing is not made to reload, and `hasUnpublishedChanges`
is simply `draft.revision > version.sourceDraftRevision` — two integers, no
timestamps to compare and no dirty flag to get out of step.

The whole publication is **one batch**: an abort statement that takes the batch
down if the revision moved, the version row, the copied steps/questions/options,
the event pointer, and the audit row. There is no window in which a version
exists but the event does not point at it, and no window in which rows are half
copied.

For a form near the contractual maximum the copy is written as **chunked
multi-row `INSERT`s** (50 rows per statement) rather than one statement per row,
so a large publication stays comfortably inside D1's per-batch limits instead of
approaching them.

### One version per draft revision

A revision can be frozen **once**. `UNIQUE(event_id, source_draft_revision)`
enforces it in the database, and the service reads by source revision before
publishing, so a second publish of an unchanged draft is answered **409
`FORM_NO_UNPUBLISHED_CHANGES`** naming the version that already holds it —
whether it is the newest one or not. `UNIQUE(event_id, version_number)` does the
same for numbering: two simultaneous publications cannot both become version 3.

### The pointer must be one of the event's own

`events.published_form_version_id` references `event_form_versions(id)`, but no
foreign key can say *and it must belong to THIS event* — SQLite has no way to
express it. So the pointer is **resolved, never trusted**. Every path that
depends on it asks `pointerCondition(eventId)`, which answers `none`, `valid`,
`foreign` (it names another event's version), `missing` (it names nothing) or
`empty` (the version has no questions). Only `valid` counts as a published form:

* `GET .../form/published` returns `publishedVersion: null`;
* `publish` and `open` stay blocked with `PUBLISHED_FORM_REQUIRED`, both in
  `blockedActions` and again at the moment of the transition;
* a pointer that is `foreign` or `missing` is **logged as an error** — that state
  cannot arise from the API, so it means something wrote the column directly.

The dev mock resolves the pointer the same way, so the builder cannot learn a
rule production does not honour.

### Rows are the runtime, the snapshot is the evidence

Each version stores both normalized `VERSION` rows and a canonical JSON
`schema_snapshot`. Reads serve the rows; the snapshot is rebuilt and compared. If
the two disagree the request **fails** with `FORM_VERSION_INVALID` (500) instead
of quietly preferring one — that disagreement is the only signal that something
went wrong with a form people have already filled in, and silently picking a
side would destroy it. The snapshot is deterministic (ordered by `sortOrder`, no
edit timestamps), so byte equality is a meaningful test.

Inactive questions are copied too, marked inactive. A version is the whole shape
of the form as it stood, not just the visible part of it.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/events/:id/form/validate-publish` | Would this revision publish? Writes nothing, caches nothing. `POST` because the verdict is about one revision |
| `POST` | `/api/events/:id/form/publish` | Freezes the draft. Body is `{ "expectedRevision": n }` |
| `GET` | `/api/events/:id/form/published` | The version served now, or `publishedVersion: null` — **200, not 404** |
| `GET` | `/api/events/:id/form/versions` | History, newest first, with the live one marked |
| `GET` | `/api/events/:id/form/versions/:versionId` | One frozen version. **404** when it belongs to another event |

There is no `PATCH` and no `DELETE` anywhere under `versions`.

### What publishing requires

`FIRST_NAME`, `LAST_NAME` and `EMAIL` must be present, active and required;
`DATE_OF_BIRTH` joins them when the event carries a minimum age. Every step must
hold at least one active question, every select at least two active options, and
no required question may be inactive. `validate-publish` returns exactly the
issues `publish` would refuse with, so the builder never offers a button that is
about to fail.

### Recovery

The normal flow never loses work: the draft survives publication untouched. For
the case where a draft has been damaged, `FormPublishingService.clonePublishedVersionToDraft()` copies a
published version back into a fresh draft — new ids, one batch, a
`FORM_DRAFT_CREATED` audit row naming the version it came from, and
a refusal (`FORM_PUBLISH_FAILED`, reason `draft_exists`) when a draft is already
there. It is deliberately a **service seam with no endpoint**: recovery is an
operator decision made on purpose, not a button that can be clicked by accident.

### Effect on the event

* `publish` and `open` require a valid published form; without one they appear in
  `blockedActions` with `PUBLISHED_FORM_REQUIRED` and the transition is refused
  with **409 `EVENT_NOT_READY`**.
* An event that has published a form can never be deleted:
  `event_form_versions.event_id` is `ON DELETE RESTRICT`, as is
  `published_by` against the admin who published it.

Audit actions emitted: `FORM_VERSION_PUBLISHED`, `FORM_VERSION_VIEWED`.

### Publishing error codes

`FORM_DRAFT_NOT_PUBLISHABLE` (422 — well-formed request, unready draft),
`FORM_NO_UNPUBLISHED_CHANGES` (409), `FORM_DRAFT_REVISION_CONFLICT` (409),
`FORM_VERSION_NUMBER_CONFLICT` (409), `FORM_VERSION_NOT_FOUND` (404),
`FORM_VERSION_INVALID` (500 — stored data disagrees with itself),
`FORM_PUBLISH_FAILED` (500).

---

### Error codes

`EVENT_NOT_FOUND` (404), `EVENT_SLUG_EXISTS` (409), `EVENT_SLUG_RESERVED` (400),
`EVENT_INVALID_SLUG` (400), `EVENT_INVALID_TRANSITION` (409),
`EVENT_INVALID_DATE_RANGE` (400), `EVENT_REQUIRED_FIELDS_MISSING` (400),
`EVENT_CANNOT_BE_EDITED` (409), `EVENT_CANNOT_BE_DELETED` (409),
`EVENT_REVISION_CONFLICT` (409), `EVENT_NOT_READY` (409),
`EVENT_DUPLICATE_FAILED` (400).

---

## Endpoints

### `POST /api/jotform/webhook/:secret` — public, protected by URL secret

Receives the form-data webhook that Jotform fires on every submission. The `:secret` URL segment must match `env.JOTFORM_WEBHOOK_SECRET` exactly (constant-time compare); any mismatch returns **404** so probes cannot detect the route.

**Request:** `multipart/form-data` from Jotform. Relevant fields:

- `submissionID` — Jotform's unique submission identifier (stored as `attendees.jotform_submission_id` for idempotency).
- `formID` — Jotform form ID; must appear in `env.JOTFORM_ALLOWED_FORM_IDS` (CSV) or the webhook is ignored with `{ ok: false, ignored: 'form_not_allowed' }`.
- `rawRequest` — JSON string of all answers, keys typically named `q{N}_{label}`. The mapping from these keys to our schema lives in `functions/_shared/jotform.ts` (`FIELD_MAP`, `GENERO_MAP`, `NIVEL_MAP`).

**Behavior:**

- Parses + validates the payload against `registerSchema`. On any parse/validation failure, returns **200** with `{ ok: false, ignored: '<code>' }` (Jotform retries aggressively on 5xx; we only want real D1 errors to bubble up).
- **Idempotent**: if a row already exists for `submissionID`, returns `{ ok: true, idempotent: true, participantNumber }` without duplicating.
- Otherwise assigns the next sequential `participant_number` via the same atomic helper used by `POST /api/register` and inserts.
- Fires-and-forgets the organizer notification email via Resend (failure non-fatal).
- Returns **200** with `{ ok: true, participantNumber, submissionId }`.

**Configure in Jotform:** Form Settings → Integrations → Webhooks → `https://{TU_DOMINIO}/api/jotform/webhook/{JOTFORM_WEBHOOK_SECRET}`.

---

### `GET /api/registration/by-submission/:id` — public

Used by the confirmation page right after Jotform's thank-you redirect. Looks up an attendee by their Jotform submission ID.

**Response 200:**
```ts
{
  participantNumber: number;
  attendee: Attendee;
}
```

**Errors:**
- 404 `PENDING` — the webhook hasn't processed this submission yet. The client interprets `PENDING` as a signal to keep polling.

**Polling contract:** the client polls every 1.5 s for up to 20 s.

---

### `POST /api/register` — public (legacy)

Register a new attendee directly via JSON. Kept as a fallback for tests / mock dev mode / direct API consumers; the production registration flow uses Jotform. Side effect: sends a copy of the registration via Resend to `env.ORGANIZER_EMAIL` (= `onelio@aaservices.com`). Email failure must **not** fail the request — log it and return success.

**Request body:**
```ts
{
  nombre: string;          // 2..120 trimmed
  email: string;           // RFC email, stored lowercase
  telefono: string;        // 7..20, digits/spaces/+/-/() only
  genero: 'M' | 'F' | 'OTRO' | 'PREFIERO_NO_DECIR';
  edad: number;            // integer 13..99
  institucion: string;     // 2..160
  carrera: string;         // 2..160
  nivelAcademico: 'SECUNDARIA' | 'PREGRADO' | 'POSGRADO' | 'OTRO';
}
```

**Response 201:**
```ts
{
  id: string;                  // uuid
  participantNumber: number;   // sequential, starting at 1
  createdAt: string;           // ISO 8601
}
```

**Errors:**
- 400 `VALIDATION_ERROR` (with `fields`)
- 409 `EMAIL_EXISTS`
- 429 `RATE_LIMIT`

**Implementation notes:**
- Assign `participant_number` atomically — wrap a `SELECT COALESCE(MAX(participant_number), 0) + 1` and the insert in `BEGIN IMMEDIATE … COMMIT`.
- Use the same `registerSchema` from `shared/schemas.ts` to validate.

---

### `POST /api/manager/login` — public

Authenticate an administrator.

**Request body:** `{ "email": string, "password": string }`

**Response 200:** plus `Set-Cookie: l33d_admin_session=…; HttpOnly; …`
```ts
{
  admin: {
    id: string;
    email: string;
    displayName: string;
    role: 'ADMIN';
    status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
    createdAt: string;
    updatedAt: string;
    lastLoginAt?: string;
  };
  expiresAt: string;   // ISO 8601
}
```

The response never contains the session token, `password_hash` or `token_hash`.

**Errors:**
- 400 `VALIDATION_ERROR` — malformed body. Deliberately returns no `fields`.
- 401 `INVALID_CREDENTIALS` — unknown email **or** wrong password. The two are
  indistinguishable by design, so the endpoint cannot enumerate accounts.
- 403 `ADMIN_SUSPENDED` / `ADMIN_DISABLED` — correct password, inactive account.
- 415 `UNSUPPORTED_MEDIA_TYPE` — body was not `application/json` (see CSRF above).
- 429 `RATE_LIMIT` — with a `Retry-After` header. Counters are persisted in D1
  per hashed email and per hashed IP (10 failures / 15 min). The two buckets
  behave differently on purpose:
  - **IP bucket — hard block.** Once exhausted the request is refused before
    the password is even checked, so volumetric guessing from one source is
    both stopped and cheap to absorb.
  - **Email bucket — refuses wrong passwords only.** A correct password from a
    non-blocked IP still succeeds. If it hard-blocked, anyone who knows an
    administrator's address could lock that person out on demand by failing ten
    logins; a guesser gains nothing, since they never supply the right password.

---

### `GET /api/manager/me` — auth

Returns the authenticated administrator. Because the session cookie is HttpOnly,
this is the SPA's only way to know whether it is signed in; `ProtectedRoute`
calls it on mount.

**Response 200:** `{ admin: AdminUser }` (same shape as in login).

**Errors (all 401):** `UNAUTHORIZED` (no cookie), `SESSION_INVALID`,
`SESSION_EXPIRED`, `SESSION_REVOKED`, `ADMIN_SUSPENDED`, `ADMIN_DISABLED`.

---

### `POST /api/manager/logout` — auth

Revokes the current session server-side by setting `admin_sessions.revoked_at`,
and expires the cookie (`Max-Age=0`). The token stops working immediately, even
if a copy was captured.

**Response 200:** `{ "ok": true }`

Idempotent: `revoked_at` is only written while it is still NULL, so repeating
the call preserves the original revocation timestamp and never errors.

---

### `GET /api/attendees?search=&page=&pageSize=` — auth

Paginated list of attendees, ordered by `participant_number DESC` so newest registrations show first.

**Query params:**
- `search` (optional): matches any of `nombre`, `email`, or `participant_number` (cast to string; allow zero-padded `001` to match `1`).
- `page` (optional, default 1, 1-based).
- `pageSize` (optional, default 25, max 200).

**Response 200:**
```ts
{
  items: Attendee[];
  total: number;
  page: number;
  pageSize: number;
}
```

`Attendee` shape:
```ts
{
  id: string;
  participantNumber: number;
  nombre: string;
  email: string;
  telefono: string;
  genero: 'M' | 'F' | 'OTRO' | 'PREFIERO_NO_DECIR';
  edad: number;
  institucion: string;
  carrera: string;
  nivelAcademico: 'SECUNDARIA' | 'PREGRADO' | 'POSGRADO' | 'OTRO';
  createdAt: string;
}
```

---

### `GET /api/attendees/:id` — auth

Fetch a single attendee by id. **200** returns `Attendee`. **404** `NOT_FOUND`.

---

### `GET /api/metrics` — auth

Aggregated metrics. The frontend polls this every 4 seconds.

**Response 200:**
```ts
{
  total: number;
  byGenero: { M: number; F: number; OTRO: number; PREFIERO_NO_DECIR: number };
  generoPercent: { M: number; F: number; OTRO: number; PREFIERO_NO_DECIR: number }; // 0..100
  byCarrera: Array<{ key: string; count: number; percent: number }>;     // sorted desc, top 10
  byInstitucion: Array<{ key: string; count: number; percent: number }>; // sorted desc, top 10
  byNivel: Array<{ key: string; count: number; percent: number }>;
  promedioEdad: number;   // one decimal place
  updatedAt: string;      // ISO
}
```

When `total === 0`, all percentages are `0` and arrays are empty.

---

### `POST /api/raffle/draw` — auth

Pick or set the raffle winner. Stores a row in `raffle_draws` and emails the winner via Resend.

**Request body:**
```ts
| { mode: 'random' }
| { mode: 'manual'; participantNumber: number }
```

**Response 200:**
```ts
{
  winner: Attendee;
  drawnAt: string;
  emailSent: boolean;   // false if Resend call failed (do NOT fail the request)
}
```

**Errors:**
- 400 `NO_ATTENDEES` (table is empty)
- 404 `WINNER_NOT_FOUND` (manual mode, number does not exist)

You may optionally enforce single-draw with 409 `RAFFLE_ALREADY_DRAWN`, but the frontend already supports redrawing without that.

---

### `GET /api/raffle/current` — auth

The most recent draw result, so the dashboard can render it on reload.

**Response 200:** `{ winner: Attendee; drawnAt: string }` or **`null`** if no draw has happened.

---

## Email templates

The real HTML + plaintext bodies live in [`functions/_shared/emails.ts`](./functions/_shared/emails.ts):

- `organizerEmail(attendee)` — sent to `env.ORGANIZER_EMAIL` after each registration. Includes the padded participant number and every attendee field in a styled HTML table.
- `winnerEmail(attendee)` — sent to the winner after a raffle draw. Includes a congratulations message, the winning participant number in large type, and instructions to reply to claim the gift card.

Both templates HTML-escape user-provided values and ship a plaintext fallback alongside the HTML. Email delivery uses Resend's `POST https://api.resend.com/emails` endpoint with `Authorization: Bearer ${RESEND_API_KEY}`. Send failures are non-fatal — they degrade gracefully (the registration succeeds, `emailSent: false` is returned for raffle draws).

---

## Required Cloudflare environment

Bindings / vars the Worker code expects (set via the Pages dashboard):

| Name | Type | Notes |
|------|------|-------|
| `DB` | D1 binding | Apply every file in `migrations/` against it. |
| `RESEND_API_KEY` | Secret | Resend API key. |
| `RESEND_FROM` | Var | Verified sender, e.g. `Gifted Grads <noreply@aaservices.com>`. |
| `ORGANIZER_EMAIL` | Var | `onelio@aaservices.com` |
