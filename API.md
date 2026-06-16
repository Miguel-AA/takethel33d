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
- `INVALID_PASSWORD` (401)
- `UNAUTHORIZED` (401)
- `NOT_FOUND` (404)
- `WINNER_NOT_FOUND` (404)
- `NO_ATTENDEES` (400)
- `RAFFLE_ALREADY_DRAWN` (409, optional)
- `RATE_LIMIT` (429)
- `SERVER_ERROR` (500)

## Authentication

The manager dashboard uses a single shared password.

1. Frontend calls `POST /api/manager/login` with the password.
2. Worker compares (constant time) against `env.MANAGER_PASSWORD`.
3. On match: generate a random token (`crypto.randomUUID()`), insert into `manager_sessions` with `expires_at = now + 12h`, return `{ token, expiresAt }`.
4. Frontend stores token in `localStorage`. All authenticated requests are sent with `Authorization: Bearer <token>`.
5. The `_middleware.ts` for protected routes validates `Authorization` and rejects with 401 `UNAUTHORIZED` when missing/expired/unknown.

Protected endpoints (require valid Bearer token):
- `GET /api/manager/me`
- `GET /api/attendees`
- `GET /api/attendees/:id`
- `GET /api/metrics`
- `POST /api/raffle/draw`
- `GET /api/raffle/current`

Public endpoints:
- `POST /api/register` (legacy fallback — production registration goes through Jotform)
- `POST /api/manager/login`
- `POST /api/jotform/webhook/:secret`
- `GET /api/registration/by-submission/:id`

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

Authenticate the manager.

**Request body:** `{ "password": string }`

**Response 200:**
```ts
{
  token: string;       // opaque random string
  expiresAt: string;   // ISO 8601
}
```

**Errors:** 401 `INVALID_PASSWORD`, 429 `RATE_LIMIT`.

---

### `GET /api/manager/me` — auth

Lightweight check that the bearer token is still valid. The frontend calls this from `ProtectedRoute` on mount.

**Response 200:** `{ "ok": true }`. 401 `UNAUTHORIZED` otherwise.

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
| `DB` | D1 binding | Apply `migrations/0001_init.sql` against it. |
| `MANAGER_PASSWORD` | Secret | Shared password for the manager dashboard. |
| `RESEND_API_KEY` | Secret | Resend API key. |
| `RESEND_FROM` | Var | Verified sender, e.g. `Gifted Grads <noreply@aaservices.com>`. |
| `ORGANIZER_EMAIL` | Var | `onelio@aaservices.com` |
