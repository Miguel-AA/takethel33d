// Shared scaffolding for the public-flow suites.
//
// Seeding a public event is not a two-line affair — it needs an administrator,
// an event with a coherent window, a form draft, its system-field questions, a
// publication and an OPEN transition — and four suites need exactly the same
// one. Duplicating it would mean four subtly different fixtures and four places
// to update when the domain moves.
//
// Everything here goes through the REAL services, never raw SQL, so a fixture
// cannot construct a state the application itself would refuse.

import { ParticipantRegistrationService } from '../../functions/_shared/participantRegistrationService';
import { FormPublishingService } from '../../functions/_shared/formPublishingService';
import { FormDraftService } from '../../functions/_shared/formDraftService';
import { EventLifecycleService } from '../../functions/_shared/eventService';
import { AdminRepository } from '../../functions/_shared/adminRepository';
import { hashPassword } from '../../functions/_shared/password';
import { normalizeEmail } from '../../shared/schemas';
import { onRequest as middleware } from '../../functions/_middleware';
import { createTestDatabase, type TestDatabase } from './d1';
import type {
  AuthenticatedAdmin,
  Event,
  EventFormVersion,
  SubmittedAnswer,
} from '../../shared/types';

export const PUBLIC_TEST_SECRET = 'test-only-public-form-token-secret-value';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

export const DOB_QUESTION = {
  type: 'DATE',
  systemField: 'DATE_OF_BIRTH',
  label: 'Date of birth',
  required: true,
} as const;

/**
 * The client's questions, as configuration rather than code.
 *
 * They exist in the fixtures precisely to prove they are NOT special: nothing
 * in the wizard, the projection or the eligibility rule knows these keys, and
 * the tests assert that changing their answers changes nothing about who
 * qualifies.
 */
export const HABIT_QUESTIONS = [
  {
    type: 'SINGLE_SELECT',
    label: 'Do you smoke?',
    key: 'smoker_status',
    required: false,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    type: 'SINGLE_SELECT',
    label: 'Do you drink?',
    key: 'drinker_status',
    required: false,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
];

export interface PublicHarness {
  db: TestDatabase;
  admin: AuthenticatedAdmin;
  events: EventLifecycleService;
  drafts: FormDraftService;
  publishing: FormPublishingService;
  registration: ParticipantRegistrationService;
  actor: () => { admin: AuthenticatedAdmin; requestContext: never };
  close(): void;
}

export async function createHarness(): Promise<PublicHarness> {
  const db = createTestDatabase();

  const created = await new AdminRepository(db.d1).create({
    email: 'ada@example.com',
    normalizedEmail: normalizeEmail('ada@example.com'),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword('a-strong-admin-password'),
  });
  if (created.kind !== 'created') throw new Error('admin seed failed');

  const admin: AuthenticatedAdmin = {
    id: created.admin.id,
    email: created.admin.email,
    displayName: created.admin.displayName,
    role: 'ADMIN',
    status: 'ACTIVE',
    sessionId: 'session-public-tests',
  };

  const requestContext = {
    requestId: 'req-public-seed',
    ipHash: 'a'.repeat(64),
    userAgent: 'vitest',
    origin: null,
    method: 'POST',
    pathname: '/seed',
  };

  return {
    db,
    admin,
    events: new EventLifecycleService(db.d1),
    drafts: new FormDraftService(db.d1),
    publishing: new FormPublishingService(db.d1),
    registration: new ParticipantRegistrationService(db.d1),
    actor: () => ({ admin, requestContext }) as never,
    close: () => db.close(),
  };
}

export interface SeedOptions {
  slug?: string;
  minimumAge?: number | null;
  /** Extra questions beyond the three mandatory system fields. */
  extra?: Array<Record<string, unknown>>;
  /** Leave the event SCHEDULED instead of opening it. */
  open?: boolean;
  timezone?: string;
  registrationOpensAt?: string;
  registrationClosesAt?: string;
  /**
   * Runs while the event is still a DRAFT, just before it is published.
   *
   * The draw suites need prizes, and prizes can only be created before an event
   * opens — `PRIZE_CAPABILITIES_BY_EVENT_STATUS` gives OPEN only
   * `editEditorial`. Rather than each suite rebuilding this whole fixture to
   * slip one step in, the fixture offers the seam. Optional, so every existing
   * caller is unchanged.
   */
  onDraft?: (eventId: string) => Promise<void>;
}

/** An event with a published form, open for entries unless told otherwise. */
export async function seedPublicEvent(
  harness: PublicHarness,
  options: SeedOptions = {},
): Promise<{ event: Event; version: EventFormVersion }> {
  const { events, drafts, publishing, actor, db } = harness;

  // A SCHEDULED event is one whose registration has not started, and the
  // `publish` transition enforces exactly that — so the window has to be in the
  // future for it, and in the past for an event that is meant to be open.
  const scheduledOnly = options.open === false;

  const made = await events.create(
    {
      name: 'Public Flow Event',
      ...(options.slug ? { slug: options.slug } : {}),
      registrationOpensAt:
        options.registrationOpensAt ?? (scheduledOnly ? at(1) : at(-1)),
      registrationClosesAt: options.registrationClosesAt ?? at(5),
      startsAt: at(6),
      endsAt: at(7),
    } as never,
    actor(),
  );
  if (!made.ok) throw new Error(JSON.stringify(made.failure));
  const created = made.value;

  const ensured = await drafts.ensure(created.id, actor());
  if (!ensured.ok) throw new Error(ensured.failure.code);
  let form = ensured.value.draft;

  const step = await drafts.createStep(
    created.id,
    { expectedRevision: form.revision, title: 'About you' },
    actor(),
  );
  if (!step.ok) throw new Error(step.failure.code);
  form = step.value;

  for (const spec of [
    { type: 'SHORT_TEXT', systemField: 'FIRST_NAME', label: 'First name', required: true },
    { type: 'SHORT_TEXT', systemField: 'LAST_NAME', label: 'Last name', required: true },
    { type: 'EMAIL', systemField: 'EMAIL', label: 'Email', required: true },
    ...(options.extra ?? []),
  ]) {
    const question = await drafts.createQuestion(
      created.id,
      { expectedRevision: form.revision, stepId: form.steps[0].id, ...spec } as never,
      actor(),
    );
    if (!question.ok) {
      throw new Error(`${JSON.stringify(spec)} -> ${question.failure.code}`);
    }
    form = question.value;
  }

  // Written directly because `minimum_age` is frozen once an event opens, and
  // several suites need an age rule on an already-open event.
  if (options.minimumAge !== undefined) {
    db.raw
      .prepare('UPDATE events SET minimum_age = ? WHERE id = ?')
      .run(options.minimumAge, created.id);
  }
  if (options.timezone) {
    db.raw
      .prepare('UPDATE events SET timezone = ? WHERE id = ?')
      .run(options.timezone, created.id);
  }

  // The last moment at which the event is still a DRAFT and everything about
  // it is still editable.
  if (options.onDraft) await options.onDraft(created.id);

  const published = await publishing.publish(created.id, form.revision, actor());
  if (!published.ok) throw new Error(published.failure.code);

  const transition = scheduledOnly ? 'publish' : 'open';
  const moved = await events.transition(created.id, transition, actor());
  if (!moved.ok) throw new Error(JSON.stringify(moved.failure));

  const reloaded = await events.findById(created.id);
  if (!reloaded) throw new Error('event vanished');
  return { event: reloaded, version: published.value.version };
}

/** Builds the answers a submission carries, keyed by question KEY for readability. */
export function answersFor(
  version: EventFormVersion,
  overrides: Record<string, unknown> = {},
): SubmittedAnswer[] {
  const values: Record<string, unknown> = {
    first_name: 'Ana',
    last_name: 'Lopez',
    email: 'Ana@Example.com',
    ...overrides,
  };
  const byKey = new Map(
    version.steps.flatMap((step) => step.questions).map((q) => [q.key, q]),
  );

  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const question = byKey.get(key);
      if (!question) throw new Error(`no question keyed ${key}`);
      return { questionId: question.id, value };
    });
}

/** A date of birth that makes somebody exactly `years` old today, in UTC. */
export function dobForAge(years: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${Number(today.slice(0, 4)) - years}${today.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Driving the handlers
// ---------------------------------------------------------------------------

export interface InvokeOptions {
  secret?: string | undefined;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent verbatim, so a test can post something a schema must refuse. */
  rawBody?: string;
  cookie?: string;
}

/**
 * Runs a request through the REAL middleware and into a handler.
 *
 * Going through the middleware rather than calling the handler directly is what
 * makes these tests prove the routing classification as well as the handler:
 * if `/api/public-events/...` were ever added to `PROTECTED_ROUTES`, every one
 * of them would fail with 401 instead of quietly passing.
 */
export async function invokePublic(
  db: TestDatabase,
  handler: (ctx: never) => Promise<Response>,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
  options: InvokeOptions = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      'CF-Connecting-IP': '203.0.113.7',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.rawBody !== undefined
      ? { body: options.rawBody }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  };

  const request = new Request(`https://example.com${path}`, init);
  const pending: Promise<unknown>[] = [];
  const data: Record<string, unknown> = {};

  const env = {
    DB: db.d1,
    ...('secret' in options
      ? { PUBLIC_FORM_TOKEN_SECRET: options.secret }
      : { PUBLIC_FORM_TOKEN_SECRET: PUBLIC_TEST_SECRET }),
  };

  const ctx = {
    request,
    env,
    data,
    params,
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    next: async () =>
      handler({
        request,
        env,
        data,
        params,
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      } as never),
  };

  const response = await middleware(ctx as never);
  await Promise.allSettled(pending);
  return response;
}
