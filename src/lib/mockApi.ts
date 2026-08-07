// In-memory API used by `npm run dev` when no backend is configured.
//
// IMPORTANT — this mock does NOT reproduce the real security model:
//   * passwords are compared in PLAINTEXT here; the real backend stores only a
//     PBKDF2 hash and never sees a reversible value.
//   * the session is a plain object in memory; the real backend stores only a
//     SHA-256 token hash and ships the token in an HttpOnly cookie.
// What it DOES reproduce faithfully is the observable behaviour the SPA
// depends on: individual admin accounts, email+password login, identical
// responses for unknown-email and wrong-password, suspended/disabled accounts
// being refused, and logout genuinely invalidating the session.

import type {
  AdminLoginResponse,
  AdminLogoutResponse,
  AdminMeResponse,
  AdminStatus,
  AdminUser,
  AuditListResponse,
  AuditLog,
  Attendee,
  AttendeeListResponse,
  CurrentRaffleResponse,
  EducationBreakdown,
  EducationLevel,
  HousingStatus,
  Metrics,
  RaffleDrawRequest,
  RaffleDrawResponse,
  RegisterRequest,
  RegisterResponse,
} from '@shared/types';
import type {
  CreateEventInput,
  DuplicateEventInput,
  Event,
  EventDetailResponse,
  EventListResponse,
  EventStatus,
  EventSummary,
  EventTransitionAction,
  EventTransitionResponse,
  CreateEventPrizeInput,
  EventPrize,
  EventPrizeDetailResponse,
  EventPrizeListResponse,
  EventPrizeSummary,
  EventPrizeSummaryCounts,
  PrizeCapability,
  PrizeMutationResponse,
  PrizeStatus,
  PrizeTransitionAction,
  ReorderEventPrizeItem,
  UpdateEventPrizeInput,
  CreateFormOptionInput,
  CreateFormQuestionInput,
  CreateFormStepInput,
  EventFormDraft,
  EventFormDraftResponse,
  FormDraftMutationResponse,
  FormPreviewResponse,
  FormQuestion,
  FormQuestionOption,
  FormQuestionType,
  FormQuestionValidation,
  FormStep,
  ReorderFormItem,
  UpdateFormOptionInput,
  UpdateFormQuestionInput,
  UpdateFormStepInput,
  EventFormVersion,
  EventFormVersionDetailResponse,
  EventFormVersionListResponse,
  FormPublishValidationResponse,
  PublishFormResponse,
  PublishedFormResponse,
  UpdateEventInput,
  CreateEventEntryResponse,
  EventEntry,
  EventEntryAnswer,
  EventEntryDetail,
  EventEntryListResponse,
  EventEntrySummary,
  Participant,
  SubmittedAnswer,
} from '@shared/types';
import { EDUCATION_LEVELS } from '@shared/types';
import { normalizeEmail } from '@shared/schemas';
import {
  ACTION_TARGET,
  EDITABLE_FIELDS_BY_STATUS,
  REQUIRED_FIELDS_FOR_STATUS,
  REQUIRED_TIMESTAMPS_FOR_STATUS,
  TIMING_PRECONDITIONS,
  PUBLISHED_FORM_REQUIRED,
  actionRequiresPublishedForm,
  allowedActions,
  canTransition,
} from '@shared/eventLifecycle';
import {
  PRIZE_ACTION_TARGET,
  allowedPrizeActions,
  canDeletePrize,
  canPrizeTransition,
  editableFieldsFor,
  eventAllows,
} from '@shared/prizeLifecycle';
import {
  NAMED_SYSTEM_FIELDS,
  SYSTEM_FIELD_KEY,
  SYSTEM_FIELD_TYPE,
  VALIDATION_KEYS_BY_TYPE,
  canDeleteQuestion,
  editableQuestionFields,
  eventAllowsFormEditing,
  isReservedQuestionKey,
  questionTypeCollectsAnswer,
  questionTypeSupportsOptions,
  questionTypeSupportsPlaceholder,
} from '@shared/formLifecycle';
import {
  buildFormSnapshot,
  evaluatePublishability,
  hasUnpublishedChanges,
  type FormSchemaSnapshot,
} from '@shared/formPublishing';
import {
  extractParticipantProfile,
  validateSubmission,
  type AcceptedAnswer,
  type AnswerType,
} from '@shared/formAnswers';
import { entryWindowProblem } from '@shared/entryLifecycle';
import {
  civilDateInEventZone,
  evaluateAgeEligibility,
  statusForDecision,
} from '@shared/eligibility';
import { isValidTimeZone } from '@shared/timezone';
import {
  ANSWERS_PER_ENTRY_MAX,
  FORM_OPTIONS_PER_QUESTION_MAX,
  FORM_QUESTIONS_MAX,
  FORM_STEPS_MAX,
  PRIZES_PER_EVENT_MAX,
} from '@shared/limits';
import { isReservedSlug, slugify } from '@shared/slug';
import { ApiError } from './api';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

interface MockAdmin extends AdminUser {
  normalizedEmail: string;
  /** Dev-only plaintext. See the file header. */
  password: string;
}

/**
 * Demo accounts for local development. These credentials only ever exist in
 * the browser's memory in mock mode — they are not seeded into any database
 * and grant no access to a real deployment.
 */
const DEV_PASSWORD = 'l33d-dev-password';

function makeMockAdmin(
  email: string,
  displayName: string,
  status: AdminStatus,
): MockAdmin {
  const createdAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    email,
    normalizedEmail: normalizeEmail(email),
    displayName,
    role: 'ADMIN',
    status,
    createdAt,
    updatedAt: createdAt,
    password: DEV_PASSWORD,
  };
}

const adminUsers: MockAdmin[] = [
  makeMockAdmin('admin@l33d.test', 'Dev Admin', 'ACTIVE'),
  makeMockAdmin('suspended@l33d.test', 'Suspended Admin', 'SUSPENDED'),
  makeMockAdmin('disabled@l33d.test', 'Disabled Admin', 'DISABLED'),
];

interface MockSession {
  id: string;
  adminUserId: string;
  expiresAt: string;
  revokedAt: string | null;
}

let activeSession: MockSession | null = null;

/** Strips the dev-only secret before anything is returned to the caller. */
function toPublicAdmin(admin: MockAdmin): AdminUser {
  const { password: _password, normalizedEmail: _normalizedEmail, ...publicFields } = admin;
  void _password;
  void _normalizedEmail;
  return publicFields;
}

const educationLevels: EducationLevel[] = EDUCATION_LEVELS;
const housingStatuses: HousingStatus[] = ['OWNER', 'RENTER'];
const namesSeed: Array<[string, string]> = [
  ['Ana', 'López'],
  ['Carlos', 'Pérez'],
  ['María', 'García'],
  ['Juan', 'Rodríguez'],
  ['Lucía', 'Fernández'],
  ['Pedro', 'Sánchez'],
  ['Sofía', 'Ramírez'],
  ['Diego', 'Torres'],
  ['Valeria', 'Castro'],
  ['Andrés', 'Morales'],
  ['Camila', 'Vargas'],
  ['Mateo', 'Herrera'],
  ['Isabella', 'Ruiz'],
  ['Sebastián', 'Mendoza'],
  ['Daniela', 'Rojas'],
];

const attendees: Attendee[] = [];
let nextNumber = 1;
let currentWinner: CurrentRaffleResponse | null = null;
const drawnAttendeeIds = new Set<string>();

function seed() {
  if (attendees.length > 0) return;
  const now = Date.now();
  namesSeed.forEach(([firstName, lastName], i) => {
    attendees.push({
      id: crypto.randomUUID(),
      participantNumber: nextNumber++,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}${i}@example.com`,
      phone: `+1 555 000 ${(1000 + i).toString().slice(-4)}`,
      highestLevelOfEducation: educationLevels[i % educationLevels.length],
      age: 22 + (i % 30),
      zip: `${33000 + i}`,
      city: 'Miami',
      housingStatus: housingStatuses[i % housingStatuses.length],
      ownsVehicle: i % 2 === 0,
      isBusinessOwner: i % 3 === 0,
      createdAt: new Date(now - (namesSeed.length - i) * 60_000).toISOString(),
    });
  });
}

function delay<T>(value: T, ms = 150): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function emptyEducation(): EducationBreakdown {
  return EDUCATION_LEVELS.reduce((acc, level) => {
    acc[level] = 0;
    return acc;
  }, {} as EducationBreakdown);
}

function computeMetrics(): Metrics {
  const total = attendees.length;
  const byHousingStatus = { OWNER: 0, RENTER: 0, unknown: 0 };
  const byVehicle = { yes: 0, no: 0, unknown: 0 };
  const byBusinessOwner = { yes: 0, no: 0, unknown: 0 };
  const byEducation = emptyEducation();

  for (const a of attendees) {
    if (a.housingStatus === 'OWNER' || a.housingStatus === 'RENTER') byHousingStatus[a.housingStatus]++;
    else byHousingStatus.unknown++;

    if (a.ownsVehicle === true) byVehicle.yes++;
    else if (a.ownsVehicle === false) byVehicle.no++;
    else byVehicle.unknown++;

    if (a.isBusinessOwner === true) byBusinessOwner.yes++;
    else if (a.isBusinessOwner === false) byBusinessOwner.no++;
    else byBusinessOwner.unknown++;

    if (a.highestLevelOfEducation) byEducation[a.highestLevelOfEducation]++;
  }

  const todayPrefix = new Date().toISOString().slice(0, 10);
  const leadsToday = attendees.filter((a) => a.createdAt.startsWith(todayPrefix)).length;
  return {
    total,
    leadsToday,
    byHousingStatus,
    byVehicle,
    byBusinessOwner,
    byEducation,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mirrors the middleware's checks in the same order, so mock mode fails for
 * the same reasons and with the same codes as the real backend.
 */
function requireAuth(): MockAdmin {
  if (!activeSession) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing session');
  }
  if (activeSession.revokedAt) {
    throw new ApiError(401, 'SESSION_REVOKED', 'Session revoked');
  }
  if (new Date(activeSession.expiresAt).getTime() <= Date.now()) {
    throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired');
  }
  const admin = adminUsers.find((a) => a.id === activeSession?.adminUserId);
  if (!admin) {
    throw new ApiError(401, 'SESSION_INVALID', 'Session owner no longer exists');
  }
  // Re-checked on every request: suspending an admin invalidates live sessions.
  if (admin.status === 'SUSPENDED') {
    throw new ApiError(401, 'ADMIN_SUSPENDED', 'Administrator suspended');
  }
  if (admin.status === 'DISABLED') {
    throw new ApiError(401, 'ADMIN_DISABLED', 'Administrator disabled');
  }
  return admin;
}

// --- Audit trail ----------------------------------------------------------
// Enough entries to exercise pagination, filtering and the detail view. The
// shape matches the real API exactly; only persistence is simulated.

const auditLogs: AuditLog[] = [];

function seedAuditLogs(): void {
  if (auditLogs.length > 0) return;
  const admin = adminUsers[0];
  const actions = [
    'ADMIN_LOGIN_SUCCEEDED',
    'ADMIN_LOGOUT',
    'ADMIN_LOGIN_FAILED',
    'ADMIN_ACCESS_DENIED',
    'AUDIT_LOG_VIEWED',
  ] as const;

  for (let i = 0; i < 40; i++) {
    const action = actions[i % actions.length];
    const anonymous = action === 'ADMIN_LOGIN_FAILED';
    auditLogs.push({
      id: crypto.randomUUID(),
      actorAdminId: anonymous ? null : admin.id,
      actorEmail: anonymous ? null : admin.email,
      actorDisplayName: anonymous ? null : admin.displayName,
      action,
      entityType: anonymous ? 'SYSTEM' : 'ADMIN_SESSION',
      entityId: anonymous ? null : crypto.randomUUID(),
      eventId: null,
      previousData: null,
      newData: null,
      metadata: anonymous
        ? { emailMasked: 'a***@l33d.test', reason: 'invalid_credentials', rateLimited: false }
        : { sessionId: crypto.randomUUID() },
      ipHash: 'f'.repeat(64),
      userAgent: 'Mozilla/5.0 (mock)',
      requestId: `mock-${1000 + i}`,
      createdAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    });
  }
}

// --- Events ---------------------------------------------------------------
// Reproduces the OBSERVABLE contract: the same states, the same transition
// rules, the same edit restrictions, revision conflicts and slug uniqueness.
// It does not reproduce D1 — but it must never teach a different semantics.

const events: Event[] = [];

function toEventSummary(event: Event): EventSummary {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    status: event.status,
    timezone: event.timezone,
    registrationOpensAt: event.registrationOpensAt,
    startsAt: event.startsAt,
    revision: event.revision,
    updatedAt: event.updatedAt,
    archivedAt: event.archivedAt,
  };
}

function makeEvent(
  input: Partial<CreateEventInput> & { name: string },
  slug: string,
  actorId: string,
): Event {
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    slug,
    name: input.name,
    description: input.description ?? null,
    bannerUrl: input.bannerUrl ?? null,
    locationName: input.locationName ?? null,
    timezone: input.timezone ?? 'America/New_York',
    registrationOpensAt: input.registrationOpensAt ?? null,
    registrationClosesAt: input.registrationClosesAt ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    minimumAge: input.minimumAge ?? null,
    maxEntriesPerIdentity: input.maxEntriesPerIdentity ?? 1,
    status: 'DRAFT',
    confirmationTitle: input.confirmationTitle ?? null,
    confirmationMessage: input.confirmationMessage ?? null,
    ineligibleTitle: input.ineligibleTitle ?? null,
    ineligibleMessage: input.ineligibleMessage ?? null,
    revision: 1,
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: at,
    updatedAt: at,
    publishedAt: null,
    openedAt: null,
    closedAt: null,
    cancelledAt: null,
    archivedAt: null,
    publishedFormVersionId: null,
  };
}

function seedEvents(): void {
  if (events.length > 0) return;
  const admin = adminUsers[0];
  const future = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  const draft = makeEvent({ name: 'Grand Opening Smoke Shop' }, 'grand-opening-smoke-shop', admin.id);
  draft.minimumAge = 21;

  const scheduled = makeEvent({ name: 'Summer Giveaway 2026' }, 'summer-giveaway-2026', admin.id);
  scheduled.status = 'SCHEDULED';
  scheduled.registrationOpensAt = future(2);
  scheduled.registrationClosesAt = future(9);
  scheduled.startsAt = future(10);
  scheduled.endsAt = future(11);
  scheduled.publishedAt = new Date().toISOString();

  const archived = makeEvent({ name: 'Spring Raffle' }, 'spring-raffle', admin.id);
  archived.status = 'ARCHIVED';
  archived.archivedAt = new Date().toISOString();

  events.push(draft, scheduled, archived);
}

function findEvent(id: string): Event {
  const found = events.find((event) => event.id === id);
  if (!found) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  return found;
}

function resolveMockSlug(explicit: string | undefined, name: string): string {
  if (explicit) {
    if (isReservedSlug(explicit)) {
      throw new ApiError(400, 'EVENT_SLUG_RESERVED', 'Slug reserved');
    }
    if (events.some((event) => event.slug === explicit)) {
      throw new ApiError(409, 'EVENT_SLUG_EXISTS', 'Slug already used');
    }
    return explicit;
  }

  const base = slugify(name) || 'event';
  let candidate = base;
  let attempt = 2;
  while (events.some((event) => event.slug === candidate)) {
    candidate = `${base}-${attempt++}`;
  }
  return candidate;
}

function missingForMock(event: Event, target: EventStatus): string[] {
  const required = [
    ...(REQUIRED_FIELDS_FOR_STATUS[target] ?? []),
    ...(REQUIRED_TIMESTAMPS_FOR_STATUS[target] ?? []),
  ];
  return required.filter((field) => {
    const value = event[field as keyof Event];
    return value === null || value === undefined || value === '';
  });
}

/** Mirrors the server's "is this window still live?" precondition. */
function staleForMock(event: Event, action: EventTransitionAction): string[] {
  const rule = TIMING_PRECONDITIONS[action];
  if (!rule) return [];
  const now = Date.now();
  return rule.mustBeFuture.filter((field) => {
    const value = event[field as keyof Event];
    if (typeof value !== 'string') return false;
    const instant = Date.parse(value);
    return Number.isFinite(instant) && instant <= now;
  });
}

/**
 * Mirrors the server's date ordering rules.
 *
 * Only pairs where both values are present are compared, so a half-filled
 * draft is still saveable — exactly as the backend allows.
 */
function validateMockDates(window: {
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}): void {
  const at = (value: string | null | undefined) =>
    value === null || value === undefined ? null : Date.parse(value);

  const opens = at(window.registrationOpensAt);
  const closes = at(window.registrationClosesAt);
  const starts = at(window.startsAt);
  const ends = at(window.endsAt);

  const fail = (detail: string) => {
    throw new ApiError(400, 'EVENT_INVALID_DATE_RANGE', 'Invalid dates', { detail });
  };

  if (opens !== null && closes !== null && opens >= closes) fail('opens_before_closes');
  if (starts !== null && ends !== null && starts >= ends) fail('starts_before_ends');
  if (opens !== null && starts !== null && opens > starts) fail('opens_not_after_starts');
  if (closes !== null && ends !== null && closes > ends) fail('closes_not_after_ends');
}

function describeMockActions(event: Event) {
  const available: EventTransitionAction[] = [];
  const blocked: Array<{ action: EventTransitionAction; missingFields: string[] }> = [];
  for (const action of allowedActions(event.status)) {
    const blockers = [
      ...missingForMock(event, ACTION_TARGET[action]),
      ...staleForMock(event, action),
    ];
    // A draw needs something to give away. The server resolves this from the
    // ACTIVE unit count, and the button the UI renders comes from here — so the
    // mock has to know the rule too, or dev teaches a contract that does not
    // exist.
    if (action === 'mark-draw-ready' && activeUnitsOf(event.id) < 1) {
      blockers.push('ACTIVE_PRIZE_REQUIRED');
    }
    // Announcing an event means people will be asked to fill something in — and
    // the pointer must name a version of THIS event, not merely be non-null.
    if (actionRequiresPublishedForm(action) && currentVersionOf(event) === null) {
      blockers.push(PUBLISHED_FORM_REQUIRED);
    }
    if (blockers.length === 0) available.push(action);
    else blocked.push({ action, missingFields: blockers });
  }
  return { available, blocked };
}

// --- Event prizes ---------------------------------------------------------
// Reproduces the OBSERVABLE contract: the same per-event-status permissions,
// the same status transitions, revision conflicts, the per-event limit and the
// summary counts. It does not reproduce D1, but it must never accept an
// operation the backend would refuse.

const prizes: EventPrize[] = [];

function livePrizesOf(eventId: string): EventPrize[] {
  return prizes
    .filter((prize) => prize.eventId === eventId && prize.status !== 'ARCHIVED')
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function findPrizeScoped(eventId: string, prizeId: string): EventPrize {
  // Scoped exactly as the server: a prize from another event is "not found".
  const found = prizes.find((p) => p.id === prizeId && p.eventId === eventId);
  if (!found) throw new ApiError(404, 'PRIZE_NOT_FOUND', 'Prize not found');
  return found;
}

function requireCapability(event: Event, capability: PrizeCapability): void {
  if (!eventAllows(event.status, capability)) {
    throw new ApiError(409, 'PRIZE_EVENT_NOT_EDITABLE', 'Event state forbids this', {
      eventStatus: event.status,
      capability,
    });
  }
}

/** Units across ACTIVE prizes — the DRAW_READY precondition, as on the server. */
function activeUnitsOf(eventId: string): number {
  return prizes
    .filter((prize) => prize.eventId === eventId && prize.status === 'ACTIVE')
    .reduce((sum, prize) => sum + prize.quantity, 0);
}

/**
 * A detached copy.
 *
 * The store is mutable, and handing out the live object would let a caller's
 * previously-fetched prize change under it — something a real HTTP response can
 * never do, and exactly the illusion that hides a revision-conflict bug until
 * production.
 */
function snapshotPrize(prize: EventPrize): EventPrize {
  return { ...prize };
}

function summarizePrizes(eventId: string): EventPrizeSummaryCounts {
  const own = prizes.filter((prize) => prize.eventId === eventId);
  const active = own.filter((prize) => prize.status === 'ACTIVE');
  return {
    totalPrizes: own.length,
    activePrizes: active.length,
    inactivePrizes: own.filter((p) => p.status === 'INACTIVE').length,
    archivedPrizes: own.filter((p) => p.status === 'ARCHIVED').length,
    totalActiveUnits: active.reduce((sum, prize) => sum + prize.quantity, 0),
  };
}

function toPrizeSummary(prize: EventPrize): EventPrizeSummary {
  return {
    id: prize.id,
    name: prize.name,
    imageUrl: prize.imageUrl,
    quantity: prize.quantity,
    sortOrder: prize.sortOrder,
    status: prize.status,
    revision: prize.revision,
    updatedAt: prize.updatedAt,
  };
}

function assertImageUrl(value: string | null | undefined): void {
  if (value === null || value === undefined || value === '') return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return;
  } catch {
    /* falls through */
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid image url', {
    imageUrl: 'invalid_image_url',
  });
}

// --- Form builder ---------------------------------------------------------
// Reproduces the OBSERVABLE contract: one revision for the WHOLE form, the same
// per-event-state permission, the same protected system fields, the same
// limits, the same refusals. It does not reproduce D1, but it must never accept
// an operation the backend would refuse.

interface MockDraft {
  id: string;
  eventId: string;
  revision: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const formDrafts: MockDraft[] = [];
const formSteps: Array<Omit<FormStep, 'questions'>> = [];
const formQuestions: Array<Omit<FormQuestion, 'options'>> = [];
const formOptions: FormQuestionOption[] = [];

/** The draft for an event, created on first access — exactly as the server. */
function ensureDraft(eventId: string, event: Event): MockDraft {
  const existing = formDrafts.find((draft) => draft.eventId === eventId);
  if (existing) return existing;

  if (!eventAllowsFormEditing(event.status)) {
    throw new ApiError(409, 'FORM_NOT_EDITABLE', 'Event is frozen', {
      eventStatus: event.status,
    });
  }
  const admin = requireAuth();
  const at = new Date().toISOString();
  const draft: MockDraft = {
    id: crypto.randomUUID(),
    eventId,
    revision: 1,
    updatedBy: admin.id,
    createdAt: at,
    updatedAt: at,
  };
  formDrafts.push(draft);
  return draft;
}

/** Detached copies, so a cached draft cannot mutate under its holder. */
function assembleDraft(draft: MockDraft): EventFormDraft {
  const steps = formSteps
    .filter((step) => step.ownerId === draft.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    ...draft,
    steps: steps.map((step) => ({
      ...step,
      questions: formQuestions
        .filter((question) => question.stepId === step.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((question) => ({
          ...question,
          validation: question.validation ? { ...question.validation } : null,
          options: formOptions
            .filter((option) => option.questionId === question.id)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((option) => ({ ...option })),
        })),
    })),
  };
}

/** The read shape both `getFormDraft` and `createFormDraft` answer with. */
function describeDraft(draft: MockDraft | null, event: Event): EventFormDraftResponse {
  const placed = new Set(
    draft
      ? formQuestions
          .filter((question) => question.ownerId === draft.id)
          .map((question) => question.systemField)
      : [],
  );
  const published = currentVersionOf(event);
  return {
    draft: draft ? assembleDraft(draft) : null,
    eventStatus: event.status,
    editable: eventAllowsFormEditing(event.status),
    availableSystemFields: NAMED_SYSTEM_FIELDS.filter((field) => !placed.has(field)),
    publishedVersionNumber: published?.versionNumber ?? null,
    publishedVersionId: published?.id ?? null,
    publishedAt: published?.publishedAt ?? null,
    hasUnpublishedChanges: hasUnpublishedChanges(
      draft?.revision ?? null,
      published?.sourceDraftRevision ?? null,
    ),
  };
}

// --- Published versions ----------------------------------------------------
// An immutable copy. The mock stores versions in their own arrays for the same
// reason the server stores them under `form_owner_type = 'VERSION'`: publishing
// COPIES, so editing the draft afterwards cannot reach what was published.

interface MockVersion {
  id: string;
  eventId: string;
  versionNumber: number;
  sourceDraftRevision: number;
  publishedBy: string;
  publishedAt: string;
  createdAt: string;
  steps: FormStep[];
  snapshot: FormSchemaSnapshot;
}

const formVersions: MockVersion[] = [];

/**
 * The version this event serves, if the pointer genuinely names one of its own.
 *
 * The server cannot lean on a foreign key here — SQLite cannot express "and it
 * must belong to THIS event" — so it resolves the pointer instead. The mock
 * resolves it the same way, or dev would teach a contract that does not exist.
 */
function currentVersionOf(event: Event): MockVersion | null {
  if (!event.publishedFormVersionId) return null;
  const version = formVersions.find((v) => v.id === event.publishedFormVersionId) ?? null;
  if (!version || version.eventId !== event.id) return null;
  // A version with no structure is not a form to announce.
  const questions = version.steps.reduce((sum, step) => sum + step.questions.length, 0);
  return questions > 0 ? version : null;
}

/** Deep copy, so a published version can never be reached through the draft. */
function freezeSteps(steps: FormStep[]): FormStep[] {
  return steps.map((step) => ({
    ...step,
    ownerType: 'VERSION' as const,
    questions: step.questions.map((question) => ({
      ...question,
      ownerType: 'VERSION' as const,
      validation: question.validation ? { ...question.validation } : null,
      options: question.options.map((option) => ({ ...option })),
    })),
  }));
}

function toVersionShape(version: MockVersion): EventFormVersion {
  return {
    id: version.id,
    eventId: version.eventId,
    versionNumber: version.versionNumber,
    sourceDraftRevision: version.sourceDraftRevision,
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt,
    createdAt: version.createdAt,
    steps: freezeSteps(version.steps),
  };
}

// --- Participants and entries ---------------------------------------------
// Three separate stores, for the same reason the backend has three tables: an
// identity outlives any single event, a participation belongs to exactly one,
// and an answer belongs to a participation. Collapsing any two of them here
// would teach the builder a model the server does not have.

interface MockEntry extends EventEntry {
  answers: EventEntryAnswer[];
}

const participants: Participant[] = [];
const eventEntries: MockEntry[] = [];

/** Detached copies, so a cached list cannot mutate under its holder. */
function snapshotParticipant(participant: Participant): Participant {
  return { ...participant };
}

function snapshotEntry(entry: MockEntry): EventEntry {
  // The answers live on the mock's own row so the store stays simple; the API
  // shape does not carry them, and handing them out here would let a caller
  // reach the live array through a response.
  return {
    id: entry.id,
    eventId: entry.eventId,
    participantId: entry.participantId,
    formVersionId: entry.formVersionId,
    status: entry.status,
    calculatedAge: entry.calculatedAge,
    ageEligible: entry.ageEligible,
    overallEligible: entry.overallEligible,
    eligibilityReason: entry.eligibilityReason,
    submittedAt: entry.submittedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function snapshotAnswers(entry: MockEntry): EventEntryAnswer[] {
  return entry.answers.map((answer) => ({
    ...answer,
    value: Array.isArray(answer.value) ? [...answer.value] : answer.value,
  }));
}

/**
 * Refuses a submission the same way the server does, with the same codes.
 *
 * The rules themselves are not reimplemented here — `validateSubmission` is the
 * shared module both sides call. What the mock reproduces is the TRANSLATION:
 * which problem becomes which error code, in which order.
 */
function refuseSubmission(problems: ReturnType<typeof validateSubmission>): never {
  if (problems.ok) throw new Error('unreachable');
  const list = problems.problems;

  const duplicates = list.filter((problem) => problem.code === 'DUPLICATE_ANSWER');
  if (duplicates.length > 0) {
    throw new ApiError(400, 'DUPLICATE_FORM_ANSWER', 'The same question was answered twice', {
      questions: duplicates.map((problem) => problem.questionId).join(','),
    });
  }

  const unknown = list.filter((problem) => problem.code === 'UNKNOWN_QUESTION');
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'FORM_ANSWER_UNKNOWN_QUESTION',
      'That question is not part of this form',
      { questions: unknown.map((problem) => problem.questionId).join(',') },
    );
  }

  const notAllowed = list.filter((problem) => problem.code === 'NOT_ALLOWED');
  if (notAllowed.length > 0) {
    throw new ApiError(400, 'FORM_ANSWER_NOT_ALLOWED', 'That question does not take an answer', {
      questions: notAllowed.map((problem) => problem.questionId).join(','),
      reason: (notAllowed[0] as { reason: string }).reason,
    });
  }

  const invalid = list.filter((problem) => problem.code === 'INVALID_ANSWER');
  if (invalid.length > 0) {
    throw new ApiError(400, 'FORM_ANSWER_INVALID', 'One or more answers are not valid', {
      answers: invalid
        .map((problem) => {
          const detail = problem as { questionId: string; problem: string };
          return `${detail.questionId}:${detail.problem}`;
        })
        .join(','),
    });
  }

  const missing = list.filter((problem) => problem.code === 'REQUIRED_MISSING');
  throw new ApiError(422, 'FORM_REQUIRED_ANSWER_MISSING', 'A required question was not answered', {
    questions: missing.map((problem) => (problem as { questionId: string }).questionId).join(','),
    keys: missing.map((problem) => (problem as { questionKey: string }).questionKey).join(','),
  });
}

function buildMockAnswers(entryId: string, accepted: AcceptedAnswer[]): EventEntryAnswer[] {
  return accepted.map((answer) => ({
    id: crypto.randomUUID(),
    entryId,
    questionId: answer.question.id,
    // Copied from the VERSION, exactly as the server does: a caller never gets
    // to name its own key, label or type.
    questionKey: answer.question.key,
    questionLabel: answer.question.label,
    type: answer.question.type as AnswerType,
    value: answer.value,
  }));
}

function requireStep(ownerId: string, stepId: string): Omit<FormStep, 'questions'> {
  const step = formSteps.find(
    (candidate) => candidate.id === stepId && candidate.ownerId === ownerId,
  );
  if (!step) throw new ApiError(404, 'FORM_STEP_NOT_FOUND', 'Step not found');
  return step;
}

function requireQuestion(ownerId: string, questionId: string): Omit<FormQuestion, 'options'> {
  // Scoped exactly as the server: a question from another event's form is
  // "not found", never someone else's row.
  const question = formQuestions.find(
    (candidate) => candidate.id === questionId && candidate.ownerId === ownerId,
  );
  if (!question) throw new ApiError(404, 'FORM_QUESTION_NOT_FOUND', 'Question not found');
  return question;
}

/**
 * Runs a mutation under the form's single revision guard.
 *
 * The guard is checked BEFORE the change and the revision moves only once, so a
 * stale editor is refused rather than silently overwriting a colleague's work.
 */
async function mutateDraft(
  eventId: string,
  expectedRevision: number,
  mutate: (draft: MockDraft) => void,
): Promise<FormDraftMutationResponse> {
  const admin = requireAuth();
  seedEvents();
  const event = findEvent(eventId);

  if (!eventAllowsFormEditing(event.status)) {
    throw new ApiError(409, 'FORM_NOT_EDITABLE', 'Event is frozen', {
      eventStatus: event.status,
    });
  }

  const draft = formDrafts.find((candidate) => candidate.eventId === eventId);
  if (!draft) throw new ApiError(404, 'FORM_DRAFT_NOT_FOUND', 'No draft');
  if (draft.revision !== expectedRevision) {
    throw new ApiError(409, 'FORM_REVISION_CONFLICT', 'The form changed');
  }

  mutate(draft);

  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();
  draft.updatedBy = admin.id;
  return delay({ draft: assembleDraft(draft) });
}

function assertCompleteOrder(items: ReorderFormItem[], members: Array<{ id: string }>): void {
  const known = new Set(members.map((member) => member.id));
  for (const item of items) {
    if (!known.has(item.id)) {
      throw new ApiError(400, 'FORM_ORDER_INVALID', 'Unknown member', {
        reason: 'unknown_member',
      });
    }
  }
  if (items.length !== members.length) {
    throw new ApiError(400, 'FORM_ORDER_INVALID', 'Incomplete order', {
      reason: 'incomplete_order',
    });
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Duplicate id', { 'items.id': 'duplicate_id' });
  }
  if (new Set(items.map((item) => item.sortOrder)).size !== items.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Duplicate position', {
      'items.sortOrder': 'duplicate_sort_order',
    });
  }
}

function applyOrder(
  items: ReorderFormItem[],
  members: Array<{ id: string; sortOrder: number; updatedAt: string }>,
): void {
  const at = new Date().toISOString();
  for (const item of items) {
    const member = members.find((candidate) => candidate.id === item.id);
    if (!member) continue;
    member.sortOrder = item.sortOrder;
    member.updatedAt = at;
  }
}

/** The same per-type coherence the server enforces. */
function assertQuestionShape(
  type: FormQuestionType,
  fields: {
    required?: boolean;
    exportable?: boolean;
    placeholder?: string | null;
    validation?: FormQuestionValidation | null;
    hasOptions: boolean;
  },
): void {
  if (fields.hasOptions && !questionTypeSupportsOptions(type)) {
    throw new ApiError(400, 'FORM_OPTION_NOT_ALLOWED', 'No options here', { type });
  }
  if (!questionTypeCollectsAnswer(type)) {
    if (fields.required) {
      throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Cannot be required', {
        reason: 'information_cannot_be_required',
      });
    }
    if (fields.exportable) {
      throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Cannot be exported', {
        reason: 'information_cannot_be_exported',
      });
    }
  }
  if (
    fields.placeholder !== null &&
    fields.placeholder !== undefined &&
    fields.placeholder.length > 0 &&
    !questionTypeSupportsPlaceholder(type)
  ) {
    throw new ApiError(400, 'FORM_QUESTION_INVALID', 'No placeholder here', {
      reason: 'placeholder_not_supported',
    });
  }
  if (fields.validation) {
    const allowed = VALIDATION_KEYS_BY_TYPE[type];
    const offending = Object.keys(fields.validation).filter((key) => !allowed.includes(key));
    if (offending.length > 0) {
      throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Validation not supported', {
        reason: `validation_not_supported:${offending.join(',')}`,
      });
    }
  }
}

function mockDeriveKey(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'question';
  const seed = /^[a-z]/.test(base) ? base : `q_${base}`;
  if (!taken.has(seed) && !isReservedQuestionKey(seed)) return seed;
  for (let suffix = 2; suffix < 1000; suffix++) {
    if (!taken.has(`${seed}_${suffix}`)) return `${seed}_${suffix}`;
  }
  return `${seed}_x`;
}

/** The same problems the server reports; nothing is stored. */
function buildMockPreview(draft: EventFormDraft): FormPreviewResponse {
  const problems: FormPreviewResponse['problems'] = [];
  if (draft.steps.length === 0) {
    problems.push({
      code: 'NO_STEPS',
      stepId: null,
      questionId: null,
      detail: 'The form has no steps yet',
    });
  }

  let activeQuestions = 0;
  const steps = draft.steps.map((step) => {
    const visible = step.questions.filter((question) => question.active);
    activeQuestions += visible.length;

    if (step.questions.length === 0) {
      problems.push({
        code: 'EMPTY_STEP',
        stepId: step.id,
        questionId: null,
        detail: step.title,
      });
    }
    for (const question of step.questions) {
      if (
        questionTypeSupportsOptions(question.type) &&
        question.options.filter((option) => option.active).length === 0
      ) {
        problems.push({
          code: 'SELECT_WITHOUT_OPTIONS',
          stepId: step.id,
          questionId: question.id,
          detail: question.label,
        });
      }
      if (question.required && !question.active) {
        problems.push({
          code: 'REQUIRED_QUESTION_INACTIVE',
          stepId: step.id,
          questionId: question.id,
          detail: question.label,
        });
      }
    }

    return {
      id: step.id,
      title: step.title,
      description: step.description,
      questions: visible.map((question) => ({
        id: question.id,
        key: question.key,
        type: question.type,
        label: question.label,
        description: question.description,
        placeholder: question.placeholder,
        required: question.required,
        validation: question.validation,
        options: question.options
          .filter((option) => option.active)
          .map((option) => ({ value: option.value, label: option.label })),
      })),
    };
  });

  if (draft.steps.length > 0 && activeQuestions === 0) {
    problems.push({
      code: 'NO_ACTIVE_QUESTIONS',
      stepId: null,
      questionId: null,
      detail: 'Nothing would be asked',
    });
  }

  return { eventId: draft.eventId, revision: draft.revision, steps, problems };
}

/**
 * Whether anything depends on an event.
 *
 * The server's `EventRepository.hasDependencies` counts prizes in any status
 * and a form draft; both are configuration someone built, and deleting the
 * event would orphan them.
 */
function hasEventDependencies(eventId: string): boolean {
  return (
    prizes.some((prize) => prize.eventId === eventId) ||
    formDrafts.some((draft) => draft.eventId === eventId) ||
    formVersions.some((version) => version.eventId === eventId) ||
    // An entry counts most of all: it is the record that a real person took
    // part, and deleting an event must never be the thing that erases it.
    eventEntries.some((entry) => entry.eventId === eventId)
  );
}

/** Test seam: positions a prize in a status. */
export function __setMockPrizeStatus(prizeId: string, status: PrizeStatus): void {
  const prize = prizes.find((p) => p.id === prizeId);
  if (!prize) return;
  prize.status = status;
  prize.archivedAt = status === 'ARCHIVED' ? new Date().toISOString() : null;
}

/**
 * Test seam: pins the instant the mock reasons about.
 *
 * The server takes its instant as an argument, which is what makes its age
 * calculation reproducible. The mock reads a clock, so without this a parity
 * test could never pin the one moment that matters — local midnight, where the
 * event's timezone and UTC disagree about what day it is.
 */
let pinnedNow: Date | null = null;

export function __setMockClock(instant: Date | null): void {
  pinnedNow = instant;
}

function mockNow(): Date {
  return pinnedNow === null ? new Date() : new Date(pinnedNow.getTime());
}

/** Test seam: positions an event in a state (and optionally ages its window). */
export function __setMockEventStatus(
  id: string,
  status: EventStatus,
  overrides: Partial<Event> = {},
): void {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  event.status = status;
  // A state that implies a prior closure must carry its evidence, or the
  // preconditions would reject it for the wrong reason.
  if (['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED'].includes(status)) {
    event.closedAt ??= new Date().toISOString();
  }
  Object.assign(event, overrides);
}

function canDeleteMock(event: Event): boolean {
  return (
    event.status === 'DRAFT' &&
    !event.publishedAt &&
    !event.openedAt &&
    !event.closedAt &&
    !event.cancelledAt &&
    !event.archivedAt
  );
}

function mockActor(id: string) {
  const admin = adminUsers.find((a) => a.id === id);
  return {
    id,
    displayName: admin?.displayName ?? null,
    email: admin?.email ?? null,
  };
}

/** Test seam: flips an account's status to exercise suspension handling. */
export function __setMockAdminStatus(email: string, status: AdminStatus): void {
  const admin = adminUsers.find((a) => a.normalizedEmail === normalizeEmail(email));
  if (admin) admin.status = status;
}

export const mockApi = {
  async register(body: RegisterRequest): Promise<RegisterResponse> {
    seed();
    const emailLower = body.email.toLowerCase();
    if (attendees.some((a) => a.email.toLowerCase() === emailLower)) {
      throw new ApiError(409, 'EMAIL_EXISTS', 'Email ya registrado');
    }
    const attendee: Attendee = {
      id: crypto.randomUUID(),
      participantNumber: nextNumber++,
      firstName: body.firstName,
      lastName: body.lastName,
      email: emailLower,
      phone: body.phone,
      highestLevelOfEducation: body.highestLevelOfEducation,
      age: body.age,
      zip: body.zip,
      city: body.city,
      housingStatus: body.housingStatus,
      ownsVehicle: body.ownsVehicle,
      isBusinessOwner: body.isBusinessOwner,
      createdAt: new Date().toISOString(),
    };
    attendees.push(attendee);
    return delay({
      id: attendee.id,
      participantNumber: attendee.participantNumber,
      createdAt: attendee.createdAt,
    });
  },

  async login(email: string, password: string): Promise<AdminLoginResponse> {
    const admin = adminUsers.find(
      (a) => a.normalizedEmail === normalizeEmail(email),
    );

    // Unknown email and wrong password are indistinguishable, exactly as in
    // the real backend — the mock must not teach a different security model.
    if (!admin || admin.password !== password) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Status is only evaluated once the password has matched.
    if (admin.status === 'SUSPENDED') {
      throw new ApiError(403, 'ADMIN_SUSPENDED', 'This account is suspended');
    }
    if (admin.status === 'DISABLED') {
      throw new ApiError(403, 'ADMIN_DISABLED', 'This account is disabled');
    }

    const loginAt = new Date().toISOString();
    admin.lastLoginAt = loginAt;
    admin.updatedAt = loginAt;

    activeSession = {
      id: crypto.randomUUID(),
      adminUserId: admin.id,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      revokedAt: null,
    };

    return delay({
      admin: toPublicAdmin(admin),
      expiresAt: activeSession.expiresAt,
    });
  },

  async me(): Promise<AdminMeResponse> {
    const admin = requireAuth();
    return delay({ admin: toPublicAdmin(admin) });
  },

  async logout(): Promise<AdminLogoutResponse> {
    // Idempotent, and revocation is real: the session cannot be used again.
    if (activeSession && !activeSession.revokedAt) {
      activeSession.revokedAt = new Date().toISOString();
    }
    activeSession = null;
    return delay({ ok: true as const });
  },

  async listAttendees(params: {
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AttendeeListResponse> {
    requireAuth();
    seed();
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));
    const search = (params.search ?? '').trim().toLowerCase();
    const filtered = search
      ? attendees.filter(
          (a) =>
            a.firstName.toLowerCase().includes(search) ||
            a.lastName.toLowerCase().includes(search) ||
            `${a.firstName} ${a.lastName}`.toLowerCase().includes(search) ||
            a.email.toLowerCase().includes(search) ||
            String(a.participantNumber).includes(search) ||
            String(a.participantNumber).padStart(3, '0').includes(search),
        )
      : attendees;
    const sorted = [...filtered].sort(
      (a, b) => b.participantNumber - a.participantNumber,
    );
    const start = (page - 1) * pageSize;
    return delay({
      items: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
      pageSize,
    });
  },

  async getAttendee(id: string): Promise<Attendee> {
    requireAuth();
    const found = attendees.find((a) => a.id === id);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'Lead no encontrado');
    return delay(found);
  },

  async metrics(): Promise<Metrics> {
    requireAuth();
    seed();
    return delay(computeMetrics());
  },

  async drawRaffle(body: RaffleDrawRequest): Promise<RaffleDrawResponse> {
    requireAuth();
    if (attendees.length === 0) {
      throw new ApiError(400, 'NO_ATTENDEES', 'No hay leads registrados');
    }
    let winner: Attendee;
    if (body.mode === 'manual') {
      const found = attendees.find(
        (a) => a.participantNumber === body.participantNumber,
      );
      if (!found) {
        throw new ApiError(
          404,
          'WINNER_NOT_FOUND',
          'Número de participante no encontrado',
        );
      }
      if (drawnAttendeeIds.has(found.id)) {
        throw new ApiError(
          409,
          'RAFFLE_ALREADY_DRAWN',
          'Ese participante ya fue seleccionado',
        );
      }
      winner = found;
    } else {
      const available = attendees.filter((a) => !drawnAttendeeIds.has(a.id));
      if (available.length === 0) {
        throw new ApiError(
          409,
          'RAFFLE_ALREADY_DRAWN',
          'Todos los participantes ya fueron sorteados',
        );
      }
      winner = available[Math.floor(Math.random() * available.length)];
    }
    drawnAttendeeIds.add(winner.id);
    const drawnAt = new Date().toISOString();
    currentWinner = { winner, drawnAt };
    return delay({ winner, drawnAt, emailSent: true });
  },

  async currentRaffle(): Promise<CurrentRaffleResponse | null> {
    requireAuth();
    return delay(currentWinner);
  },

  async listAuditLogs(params: {
    page?: number;
    pageSize?: number;
    action?: string;
    entityType?: string;
    from?: string;
    to?: string;
  }): Promise<AuditListResponse> {
    requireAuth();
    seedAuditLogs();

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));

    // Same bound semantics as the server: a civil date covers the whole day.
    const fromBound = params.from ? `${params.from}T00:00:00.000Z` : null;
    const toBound = params.to ? `${params.to}T23:59:59.999Z` : null;

    const filtered = auditLogs.filter((entry) => {
      if (params.action && entry.action !== params.action) return false;
      if (params.entityType && entry.entityType !== params.entityType) return false;
      if (fromBound && entry.createdAt < fromBound) return false;
      if (toBound && entry.createdAt > toBound) return false;
      return true;
    });

    const sorted = [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const start = (page - 1) * pageSize;

    return delay({
      items: sorted.slice(start, start + pageSize),
      page,
      pageSize,
      total: sorted.length,
      totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)),
    });
  },

  async getAuditLog(id: string): Promise<AuditLog> {
    requireAuth();
    seedAuditLogs();
    const found = auditLogs.find((entry) => entry.id === id);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'Audit log not found');
    return delay(found);
  },

  // --- Events -------------------------------------------------------------

  async listEvents(params: {
    page?: number;
    pageSize?: number;
    status?: string;
    search?: string;
    archived?: 'active' | 'archived' | 'all';
    sort?: string;
    direction?: string;
  }): Promise<EventListResponse> {
    requireAuth();
    seedEvents();

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));
    const archived = params.archived ?? 'active';
    const search = (params.search ?? '').trim().toLowerCase();

    const filtered = events.filter((event) => {
      if (params.status && event.status !== params.status) return false;
      if (archived === 'active' && event.status === 'ARCHIVED') return false;
      if (archived === 'archived' && event.status !== 'ARCHIVED') return false;
      if (
        search &&
        !event.name.toLowerCase().includes(search) &&
        !event.slug.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });

    const key = (params.sort ?? 'createdAt') as 'createdAt' | 'updatedAt' | 'name' | 'startsAt';
    const factor = (params.direction ?? 'desc') === 'asc' ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      const left = String(a[key] ?? '');
      const right = String(b[key] ?? '');
      return left < right ? -factor : left > right ? factor : 0;
    });

    const start = (page - 1) * pageSize;
    return delay({
      items: sorted.slice(start, start + pageSize).map(toEventSummary),
      page,
      pageSize,
      total: sorted.length,
      totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)),
    });
  },

  async getEvent(id: string): Promise<EventDetailResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(id);
    const { available, blocked } = describeMockActions(event);

    return delay({
      event,
      availableActions: available,
      blockedActions: blocked,
      editableFields: [...EDITABLE_FIELDS_BY_STATUS[event.status]],
      // An event holding prizes or a form can only be archived, never deleted —
      // the server reports it the same way, and the UI must not offer a button
      // whose request would be refused.
      canDelete: canDeleteMock(event) && !hasEventDependencies(id),
      actors: {
        createdBy: mockActor(event.createdBy),
        updatedBy: mockActor(event.updatedBy),
      },
    });
  },

  async createEvent(input: CreateEventInput): Promise<Event> {
    const admin = requireAuth();
    seedEvents();

    validateMockDates(input);
    const slug = resolveMockSlug(input.slug, input.name);
    const event = makeEvent(input, slug, admin.id);
    events.push(event);
    return delay(event);
  },

  async updateEvent(id: string, input: UpdateEventInput): Promise<Event> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(id);

    // Same conflict semantics as the server, so the UI's handling is exercised.
    if (event.revision !== input.expectedRevision) {
      throw new ApiError(409, 'EVENT_REVISION_CONFLICT', 'This event changed');
    }

    const { expectedRevision: _ignored, ...patch } = input;
    void _ignored;

    const allowed = new Set<string>(EDITABLE_FIELDS_BY_STATUS[event.status]);
    const locked = Object.keys(patch).filter((field) => !allowed.has(field));
    if (locked.length > 0) {
      throw new ApiError(409, 'EVENT_CANNOT_BE_EDITED', 'Locked fields', {
        locked: locked.join(','),
      });
    }

    if (patch.slug && patch.slug !== event.slug) {
      if (isReservedSlug(patch.slug)) {
        throw new ApiError(400, 'EVENT_SLUG_RESERVED', 'Slug reserved');
      }
      if (events.some((other) => other.slug === patch.slug)) {
        throw new ApiError(409, 'EVENT_SLUG_EXISTS', 'Slug already used');
      }
    }

    // Dates are checked against the MERGED result, so one new value must agree
    // with the three already stored — same rule as the server.
    validateMockDates({
      registrationOpensAt:
        patch.registrationOpensAt !== undefined
          ? patch.registrationOpensAt
          : event.registrationOpensAt,
      registrationClosesAt:
        patch.registrationClosesAt !== undefined
          ? patch.registrationClosesAt
          : event.registrationClosesAt,
      startsAt: patch.startsAt !== undefined ? patch.startsAt : event.startsAt,
      endsAt: patch.endsAt !== undefined ? patch.endsAt : event.endsAt,
    });

    Object.assign(event, patch);
    event.revision += 1;
    event.updatedAt = new Date().toISOString();
    event.updatedBy = admin.id;
    return delay(event);
  },

  async deleteEvent(id: string, expectedRevision?: number): Promise<{ ok: true; id: string }> {
    requireAuth();
    seedEvents();
    const event = findEvent(id);

    if (expectedRevision !== undefined && event.revision !== expectedRevision) {
      throw new ApiError(409, 'EVENT_REVISION_CONFLICT', 'This event changed');
    }
    if (!canDeleteMock(event)) {
      throw new ApiError(409, 'EVENT_CANNOT_BE_DELETED', 'Cannot delete', {
        reason: 'not_a_draft',
      });
    }
    // Prizes count REGARDLESS of status, and so does a form draft: the server
    // refuses on the same basis (and the foreign keys would refuse underneath
    // it), so an archived prize or a half-built form protects its event here
    // too. Archiving the event is the way out.
    if (hasEventDependencies(id)) {
      throw new ApiError(409, 'EVENT_CANNOT_BE_DELETED', 'Cannot delete', {
        reason: 'has_dependencies',
      });
    }

    events.splice(events.indexOf(event), 1);
    return delay({ ok: true as const, id });
  },

  async duplicateEvent(id: string, input: DuplicateEventInput): Promise<Event> {
    const admin = requireAuth();
    seedEvents();
    const source = findEvent(id);

    const name = input.name ?? `${source.name} (copy)`;
    const slug = resolveMockSlug(input.slug, name);
    const copy = makeEvent(
      {
        name,
        description: source.description,
        bannerUrl: source.bannerUrl,
        locationName: source.locationName,
        timezone: source.timezone,
        minimumAge: source.minimumAge,
        maxEntriesPerIdentity: source.maxEntriesPerIdentity,
        confirmationTitle: source.confirmationTitle,
        confirmationMessage: source.confirmationMessage,
        ineligibleTitle: source.ineligibleTitle,
        ineligibleMessage: source.ineligibleMessage,
      },
      slug,
      admin.id,
    );
    events.push(copy);
    return delay(copy);
  },

  async transitionEvent(
    id: string,
    action: EventTransitionAction,
    expectedRevision?: number,
  ): Promise<EventTransitionResponse> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(id);

    if (expectedRevision !== undefined && event.revision !== expectedRevision) {
      throw new ApiError(409, 'EVENT_REVISION_CONFLICT', 'This event changed');
    }
    if (!canTransition(event.status, action)) {
      throw new ApiError(409, 'EVENT_INVALID_TRANSITION', 'Not allowed', {
        from: event.status,
        action,
      });
    }

    const target = ACTION_TARGET[action];
    const missing = missingForMock(event, target);
    if (missing.length > 0) {
      throw new ApiError(400, 'EVENT_REQUIRED_FIELDS_MISSING', 'Missing config', {
        missing: missing.join(','),
      });
    }

    const stale = staleForMock(event, action);
    if (stale.length > 0) {
      throw new ApiError(409, 'EVENT_NOT_READY', 'Dates have already passed', {
        stale: stale.join(','),
      });
    }

    // Re-checked at the moment of the transition, exactly as the server does.
    if (actionRequiresPublishedForm(action) && currentVersionOf(event) === null) {
      throw new ApiError(409, 'EVENT_NOT_READY', 'No published form', {
        stale: PUBLISHED_FORM_REQUIRED,
        action,
      });
    }

    // Re-checked at the moment of the transition, exactly as the server does:
    // deactivating the last prize after the button rendered still blocks it.
    if (action === 'mark-draw-ready' && activeUnitsOf(id) < 1) {
      throw new ApiError(409, 'EVENT_NOT_READY', 'No active prize to award', {
        stale: 'ACTIVE_PRIZE_REQUIRED',
        action,
      });
    }

    const at = new Date().toISOString();
    event.status = target;
    event.revision += 1;
    event.updatedAt = at;
    event.updatedBy = admin.id;
    if (action === 'publish') event.publishedAt ??= at;
    if (action === 'open') event.openedAt ??= at;
    if (action === 'close') event.closedAt ??= at;
    if (action === 'cancel') event.cancelledAt ??= at;
    if (action === 'archive') event.archivedAt ??= at;

    return delay({ event });
  },

  // --- Event prizes -------------------------------------------------------

  async listEventPrizes(
    eventId: string,
    params: {
      page?: number;
      pageSize?: number;
      status?: string;
      archived?: 'active' | 'archived' | 'all';
      search?: string;
      sort?: string;
      direction?: string;
    },
  ): Promise<EventPrizeListResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));
    const archived = params.archived ?? 'active';
    const search = (params.search ?? '').trim().toLowerCase();

    const filtered = prizes.filter((prize) => {
      if (prize.eventId !== eventId) return false;
      if (params.status && prize.status !== params.status) return false;
      if (archived === 'active' && prize.status === 'ARCHIVED') return false;
      if (archived === 'archived' && prize.status !== 'ARCHIVED') return false;
      if (
        search &&
        !prize.name.toLowerCase().includes(search) &&
        !(prize.description ?? '').toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });

    const key = (params.sort ?? 'sortOrder') as keyof EventPrize;
    const factor = (params.direction ?? 'asc') === 'desc' ? -1 : 1;
    const sorted = [...filtered].sort((a, b) => {
      const left = a[key] ?? '';
      const right = b[key] ?? '';
      return left < right ? -factor : left > right ? factor : 0;
    });

    const start = (page - 1) * pageSize;
    return delay({
      items: sorted.slice(start, start + pageSize).map(toPrizeSummary),
      page,
      pageSize,
      total: sorted.length,
      totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)),
      summary: summarizePrizes(eventId),
      eventStatus: event.status,
    });
  },

  async getEventPrize(eventId: string, prizeId: string): Promise<EventPrizeDetailResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const prize = findPrizeScoped(eventId, prizeId);

    return delay({
      prize: snapshotPrize(prize),
      allowedActions: allowedPrizeActions(event.status, prize.status),
      editableFields: [...editableFieldsFor(event.status, prize.status)],
      canDelete: canDeletePrize(event.status, prize.status),
      eventStatus: event.status,
    });
  },

  async createEventPrize(eventId: string, input: CreateEventPrizeInput): Promise<EventPrize> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    requireCapability(event, 'create');
    assertImageUrl(input.imageUrl);

    const own = prizes.filter((prize) => prize.eventId === eventId);
    if (own.length >= PRIZES_PER_EVENT_MAX) {
      throw new ApiError(409, 'PRIZE_LIMIT_REACHED', 'Prize limit reached', {
        limit: String(PRIZES_PER_EVENT_MAX),
      });
    }

    const live = livePrizesOf(eventId);
    const at = new Date().toISOString();
    const prize: EventPrize = {
      id: crypto.randomUUID(),
      eventId,
      name: input.name,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      quantity: input.quantity,
      sortOrder:
        input.sortOrder ??
        (live.length === 0 ? 0 : Math.max(...live.map((p) => p.sortOrder)) + 1),
      status: 'ACTIVE',
      revision: 1,
      createdBy: admin.id,
      updatedBy: admin.id,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    };
    prizes.push(prize);
    return delay(snapshotPrize(prize));
  },

  async updateEventPrize(
    eventId: string,
    prizeId: string,
    input: UpdateEventPrizeInput,
  ): Promise<EventPrize> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const prize = findPrizeScoped(eventId, prizeId);

    if (prize.revision !== input.expectedRevision) {
      throw new ApiError(409, 'PRIZE_REVISION_CONFLICT', 'This prize changed');
    }
    if (prize.status === 'ARCHIVED') {
      throw new ApiError(409, 'PRIZE_ALREADY_ARCHIVED', 'Archived');
    }

    const { expectedRevision: _ignored, ...patch } = input;
    void _ignored;

    // The server's schema refuses a patch that changes nothing, so a revision
    // bump for an empty edit must not be reachable here either.
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Empty patch', { body: 'empty_patch' });
    }

    const allowed = new Set<string>(editableFieldsFor(event.status, prize.status));
    const locked = Object.keys(patch).filter((field) => !allowed.has(field));
    if (locked.length > 0) {
      throw new ApiError(409, 'PRIZE_CANNOT_BE_EDITED', 'Locked fields', {
        locked: locked.join(','),
      });
    }
    if ('imageUrl' in patch) assertImageUrl(patch.imageUrl);

    Object.assign(prize, patch);
    prize.revision += 1;
    prize.updatedAt = new Date().toISOString();
    prize.updatedBy = admin.id;
    return delay(snapshotPrize(prize));
  },

  async deleteEventPrize(
    eventId: string,
    prizeId: string,
    expectedRevision?: number,
  ): Promise<{ ok: true; id: string }> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const prize = findPrizeScoped(eventId, prizeId);

    if (expectedRevision !== undefined && prize.revision !== expectedRevision) {
      throw new ApiError(409, 'PRIZE_REVISION_CONFLICT', 'This prize changed');
    }
    requireCapability(event, 'delete');
    if (prize.status === 'ARCHIVED') {
      throw new ApiError(409, 'PRIZE_CANNOT_BE_DELETED', 'Archived', { reason: 'archived' });
    }

    prizes.splice(prizes.indexOf(prize), 1);
    return delay({ ok: true as const, id: prizeId });
  },

  async transitionEventPrize(
    eventId: string,
    prizeId: string,
    action: PrizeTransitionAction,
    expectedRevision?: number,
  ): Promise<PrizeMutationResponse> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const prize = findPrizeScoped(eventId, prizeId);

    if (expectedRevision !== undefined && prize.revision !== expectedRevision) {
      throw new ApiError(409, 'PRIZE_REVISION_CONFLICT', 'This prize changed');
    }
    requireCapability(event, action);

    if (!canPrizeTransition(prize.status, action)) {
      throw prize.status === 'ARCHIVED'
        ? new ApiError(409, 'PRIZE_ALREADY_ARCHIVED', 'Archived')
        : new ApiError(409, 'PRIZE_INVALID_STATUS', 'Not allowed', {
            from: prize.status,
            action,
          });
    }

    const at = new Date().toISOString();
    prize.status = PRIZE_ACTION_TARGET[action];
    prize.archivedAt = prize.status === 'ARCHIVED' ? at : null;
    prize.revision += 1;
    prize.updatedAt = at;
    prize.updatedBy = admin.id;

    return delay({ prize: snapshotPrize(prize) });
  },

  async reorderEventPrizes(
    eventId: string,
    items: ReorderEventPrizeItem[],
  ): Promise<{ items: EventPrize[] }> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    requireCapability(event, 'reorder');

    const live = livePrizesOf(eventId);
    const liveIds = new Set(live.map((prize) => prize.id));

    for (const item of items) {
      if (!liveIds.has(item.prizeId)) {
        throw new ApiError(400, 'PRIZE_ORDER_INVALID', 'Unknown prize', {
          reason: 'unknown_or_archived_prize',
        });
      }
    }
    if (items.length !== live.length) {
      throw new ApiError(400, 'PRIZE_ORDER_INVALID', 'Incomplete order', {
        reason: 'incomplete_order',
      });
    }
    if (new Set(items.map((i) => i.sortOrder)).size !== items.length) {
      throw new ApiError(400, 'PRIZE_ORDER_INVALID', 'Duplicate order', {
        reason: 'duplicate_sort_order',
      });
    }
    // The server's schema refuses a repeated prize before the service is even
    // reached; without this the mock would happily apply two positions to one.
    if (new Set(items.map((i) => i.prizeId)).size !== items.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Duplicate prize', {
        'items.prizeId': 'duplicate_prize',
      });
    }

    // Revisions are checked before anything moves, as on the server.
    for (const item of items) {
      const prize = live.find((p) => p.id === item.prizeId);
      if (prize?.revision !== item.expectedRevision) {
        throw new ApiError(409, 'PRIZE_REVISION_CONFLICT', 'Order is stale');
      }
    }

    const at = new Date().toISOString();
    for (const item of items) {
      const prize = live.find((p) => p.id === item.prizeId);
      if (!prize) continue;
      prize.sortOrder = item.sortOrder;
      prize.revision += 1;
      prize.updatedAt = at;
      prize.updatedBy = admin.id;
    }

    return delay({ items: livePrizesOf(eventId).map(snapshotPrize) });
  },

  // --- Form builder -------------------------------------------------------

  /** READ ONLY, exactly as the server: reading never creates the form. */
  async getFormDraft(eventId: string): Promise<EventFormDraftResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const draft = formDrafts.find((candidate) => candidate.eventId === eventId) ?? null;
    return delay(describeDraft(draft, event));
  },

  /** Creates the form. Idempotent, so clicking twice is harmless. */
  async createFormDraft(eventId: string): Promise<EventFormDraftResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const draft = ensureDraft(eventId, event);
    return delay(describeDraft(draft, event));
  },

  async saveFormDraft(
    eventId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, () => undefined);
  },

  async previewFormDraft(eventId: string): Promise<FormPreviewResponse> {
    requireAuth();
    seedEvents();
    findEvent(eventId);
    // Read-only: previewing a form that does not exist must not create one.
    const draft = formDrafts.find((candidate) => candidate.eventId === eventId);
    if (!draft) throw new ApiError(404, 'FORM_DRAFT_NOT_FOUND', 'No draft');
    return delay(buildMockPreview(assembleDraft(draft)));
  },

  async createFormStep(
    eventId: string,
    input: CreateFormStepInput,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, input.expectedRevision, (draft) => {
      const own = formSteps.filter((step) => step.ownerId === draft.id);
      if (own.length >= FORM_STEPS_MAX) {
        throw new ApiError(409, 'FORM_LIMIT_REACHED', 'Too many steps', {
          scope: 'steps',
          limit: String(FORM_STEPS_MAX),
        });
      }
      const at = new Date().toISOString();
      formSteps.push({
        id: crypto.randomUUID(),
        ownerType: 'DRAFT',
        ownerId: draft.id,
        title: input.title,
        description: input.description ?? null,
        sortOrder: own.length === 0 ? 0 : Math.max(...own.map((s) => s.sortOrder)) + 1,
        createdAt: at,
        updatedAt: at,
      });
    });
  },

  async updateFormStep(
    eventId: string,
    stepId: string,
    input: UpdateFormStepInput,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, input.expectedRevision, (draft) => {
      const step = requireStep(draft.id, stepId);
      const { expectedRevision: _ignored, ...patch } = input;
      void _ignored;
      if (Object.keys(patch).length === 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Empty patch', { body: 'empty_patch' });
      }
      Object.assign(step, patch);
      step.updatedAt = new Date().toISOString();
    });
  },

  async deleteFormStep(
    eventId: string,
    stepId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const step = requireStep(draft.id, stepId);
      const held = formQuestions.filter((question) => question.stepId === step.id);
      if (held.length > 0) {
        throw new ApiError(409, 'FORM_STEP_NOT_EMPTY', 'Step is not empty', {
          questions: String(held.length),
        });
      }
      formSteps.splice(formSteps.indexOf(step), 1);
    });
  },

  async reorderFormSteps(
    eventId: string,
    expectedRevision: number,
    items: ReorderFormItem[],
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const own = formSteps.filter((step) => step.ownerId === draft.id);
      assertCompleteOrder(items, own);
      applyOrder(items, own);
    });
  },

  async createFormQuestion(
    eventId: string,
    input: CreateFormQuestionInput,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, input.expectedRevision, (draft) => {
      const step = requireStep(draft.id, input.stepId);
      const own = formQuestions.filter((question) => question.ownerId === draft.id);
      if (own.length >= FORM_QUESTIONS_MAX) {
        throw new ApiError(409, 'FORM_LIMIT_REACHED', 'Too many questions', {
          scope: 'questions',
          limit: String(FORM_QUESTIONS_MAX),
        });
      }

      const systemField = input.systemField ?? 'NONE';
      if (systemField !== 'NONE') {
        if (own.some((question) => question.systemField === systemField)) {
          throw new ApiError(409, 'FORM_SYSTEM_FIELD_EXISTS', 'Already placed', {
            systemField,
          });
        }
        if (input.type !== SYSTEM_FIELD_TYPE[systemField]) {
          throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Type is fixed', {
            reason: 'system_field_type_fixed',
          });
        }
      }

      const options = input.options ?? [];
      assertQuestionShape(input.type, {
        required: input.required,
        exportable: input.exportable,
        placeholder: input.placeholder,
        validation: input.validation,
        hasOptions: options.length > 0,
      });

      const taken = new Set(own.map((question) => question.key));
      const key =
        systemField !== 'NONE'
          ? SYSTEM_FIELD_KEY[systemField]
          : (input.key ?? mockDeriveKey(input.label, taken));
      if (taken.has(key)) {
        throw new ApiError(409, 'FORM_KEY_EXISTS', 'Key in use', { key });
      }
      // Three names do not behave like ordinary keys on a plain object; the
      // server refuses them in the domain, not only at its edge.
      if (isReservedQuestionKey(key)) {
        throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Reserved key', {
          reason: 'reserved_key',
        });
      }

      const siblings = formQuestions.filter((question) => question.stepId === step.id);
      const at = new Date().toISOString();
      const id = crypto.randomUUID();
      formQuestions.push({
        id,
        ownerType: 'DRAFT',
        ownerId: draft.id,
        stepId: step.id,
        key,
        systemField,
        type: input.type,
        label: input.label,
        description: input.description ?? null,
        placeholder: input.placeholder ?? null,
        required: input.required ?? false,
        active: input.active ?? true,
        exportable: (input.exportable ?? true) && questionTypeCollectsAnswer(input.type),
        sortOrder: siblings.length === 0 ? 0 : Math.max(...siblings.map((q) => q.sortOrder)) + 1,
        validation: input.validation ?? null,
        createdAt: at,
        updatedAt: at,
      });
      options.forEach((option, index) => {
        formOptions.push({
          id: crypto.randomUUID(),
          questionId: id,
          value: option.value,
          label: option.label,
          sortOrder: index,
          active: true,
          createdAt: at,
          updatedAt: at,
        });
      });
    });
  },

  async updateFormQuestion(
    eventId: string,
    questionId: string,
    input: UpdateFormQuestionInput,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, input.expectedRevision, (draft) => {
      const question = requireQuestion(draft.id, questionId);
      const { expectedRevision: _ignored, ...patch } = input;
      void _ignored;
      if (Object.keys(patch).length === 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Empty patch', { body: 'empty_patch' });
      }

      const allowed = editableQuestionFields(question.systemField);
      const forbidden = Object.keys(patch).filter(
        (field) => field !== 'stepId' && !allowed.includes(field),
      );
      if (forbidden.length > 0) {
        throw new ApiError(409, 'FORM_QUESTION_PROTECTED', 'Protected field', {
          reason: forbidden.join(','),
        });
      }

      const held = formOptions.filter((option) => option.questionId === question.id);
      const nextType = patch.type ?? question.type;
      if (!questionTypeSupportsOptions(nextType) && held.length > 0) {
        throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Would strand options', {
          reason: 'type_change_would_strand_options',
        });
      }
      assertQuestionShape(nextType, {
        required: patch.required ?? question.required,
        exportable: patch.exportable ?? question.exportable,
        placeholder: patch.placeholder === undefined ? question.placeholder : patch.placeholder,
        validation: patch.validation === undefined ? question.validation : patch.validation,
        hasOptions: held.length > 0,
      });

      if (patch.key !== undefined && patch.key !== question.key) {
        const clash = formQuestions.some(
          (other) =>
            other.ownerId === draft.id && other.id !== question.id && other.key === patch.key,
        );
        if (clash) throw new ApiError(409, 'FORM_KEY_EXISTS', 'Key in use', { key: patch.key });
        if (isReservedQuestionKey(patch.key)) {
          throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Reserved key', {
            reason: 'reserved_key',
          });
        }
      }

      if (patch.stepId !== undefined && patch.stepId !== question.stepId) {
        const destination = requireStep(draft.id, patch.stepId);
        const siblings = formQuestions.filter((q) => q.stepId === destination.id);
        question.sortOrder =
          siblings.length === 0 ? 0 : Math.max(...siblings.map((q) => q.sortOrder)) + 1;
      }

      Object.assign(question, patch);
      question.updatedAt = new Date().toISOString();
    });
  },

  async deleteFormQuestion(
    eventId: string,
    questionId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const question = requireQuestion(draft.id, questionId);
      if (!canDeleteQuestion(question.systemField, question.required)) {
        throw new ApiError(409, 'FORM_QUESTION_PROTECTED', 'Protected question', {
          reason: 'required_system_field',
        });
      }
      for (const option of formOptions.filter((o) => o.questionId === question.id)) {
        formOptions.splice(formOptions.indexOf(option), 1);
      }
      formQuestions.splice(formQuestions.indexOf(question), 1);
    });
  },

  async duplicateFormQuestion(
    eventId: string,
    questionId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const source = requireQuestion(draft.id, questionId);
      const own = formQuestions.filter((question) => question.ownerId === draft.id);
      if (own.length >= FORM_QUESTIONS_MAX) {
        throw new ApiError(409, 'FORM_LIMIT_REACHED', 'Too many questions', {
          scope: 'questions',
          limit: String(FORM_QUESTIONS_MAX),
        });
      }

      const taken = new Set(own.map((question) => question.key));
      const at = new Date().toISOString();
      const id = crypto.randomUUID();
      const siblings = own.filter((question) => question.stepId === source.stepId);

      formQuestions.push({
        ...source,
        id,
        // A copy is never a system field: those may appear only once.
        systemField: 'NONE',
        key: mockDeriveKey(`${source.key}_copy`, taken),
        sortOrder: Math.max(...siblings.map((q) => q.sortOrder)) + 1,
        createdAt: at,
        updatedAt: at,
      });

      formOptions
        .filter((option) => option.questionId === source.id)
        .forEach((option, index) => {
          formOptions.push({
            ...option,
            id: crypto.randomUUID(),
            questionId: id,
            sortOrder: index,
            createdAt: at,
            updatedAt: at,
          });
        });
    });
  },

  async reorderFormQuestions(
    eventId: string,
    expectedRevision: number,
    stepId: string,
    items: ReorderFormItem[],
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const step = requireStep(draft.id, stepId);
      const own = formQuestions.filter((question) => question.stepId === step.id);
      assertCompleteOrder(items, own);
      applyOrder(items, own);
    });
  },

  async createFormOption(
    eventId: string,
    questionId: string,
    input: CreateFormOptionInput,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, input.expectedRevision, (draft) => {
      const question = requireQuestion(draft.id, questionId);
      if (!questionTypeSupportsOptions(question.type)) {
        throw new ApiError(400, 'FORM_OPTION_NOT_ALLOWED', 'No options here', {
          type: question.type,
        });
      }
      const own = formOptions.filter((option) => option.questionId === question.id);
      if (own.length >= FORM_OPTIONS_PER_QUESTION_MAX) {
        throw new ApiError(409, 'FORM_LIMIT_REACHED', 'Too many options', {
          scope: 'options',
          limit: String(FORM_OPTIONS_PER_QUESTION_MAX),
        });
      }
      if (own.some((option) => option.value === input.value)) {
        throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Duplicate value', {
          reason: 'duplicate_option_value',
        });
      }
      const at = new Date().toISOString();
      formOptions.push({
        id: crypto.randomUUID(),
        questionId: question.id,
        value: input.value,
        label: input.label,
        sortOrder: own.length === 0 ? 0 : Math.max(...own.map((o) => o.sortOrder)) + 1,
        active: input.active ?? true,
        createdAt: at,
        updatedAt: at,
      });
    });
  },

  async updateFormOption(
    eventId: string,
    questionId: string,
    optionId: string,
    input: UpdateFormOptionInput,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, input.expectedRevision, (draft) => {
      const question = requireQuestion(draft.id, questionId);
      const option = formOptions.find(
        (candidate) => candidate.id === optionId && candidate.questionId === question.id,
      );
      if (!option) throw new ApiError(404, 'FORM_OPTION_NOT_FOUND', 'Option not found');

      const { expectedRevision: _ignored, ...patch } = input;
      void _ignored;
      if (Object.keys(patch).length === 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Empty patch', { body: 'empty_patch' });
      }
      if (
        patch.value !== undefined &&
        formOptions.some(
          (other) =>
            other.questionId === question.id &&
            other.id !== option.id &&
            other.value === patch.value,
        )
      ) {
        throw new ApiError(400, 'FORM_QUESTION_INVALID', 'Duplicate value', {
          reason: 'duplicate_option_value',
        });
      }
      Object.assign(option, patch);
      option.updatedAt = new Date().toISOString();
    });
  },

  async deleteFormOption(
    eventId: string,
    questionId: string,
    optionId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const question = requireQuestion(draft.id, questionId);
      const option = formOptions.find(
        (candidate) => candidate.id === optionId && candidate.questionId === question.id,
      );
      if (!option) throw new ApiError(404, 'FORM_OPTION_NOT_FOUND', 'Option not found');
      formOptions.splice(formOptions.indexOf(option), 1);
    });
  },

  async reorderFormOptions(
    eventId: string,
    questionId: string,
    expectedRevision: number,
    items: ReorderFormItem[],
  ): Promise<FormDraftMutationResponse> {
    return mutateDraft(eventId, expectedRevision, (draft) => {
      const question = requireQuestion(draft.id, questionId);
      const own = formOptions.filter((option) => option.questionId === question.id);
      assertCompleteOrder(items, own);
      applyOrder(items, own);
    });
  },

  // --- Publishing ---------------------------------------------------------

  async validatePublishForm(
    eventId: string,
    expectedDraftRevision?: number,
  ): Promise<FormPublishValidationResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const stored = formDrafts.find((candidate) => candidate.eventId === eventId) ?? null;
    const draft = stored ? assembleDraft(stored) : null;

    if (
      expectedDraftRevision !== undefined &&
      draft !== null &&
      draft.revision !== expectedDraftRevision
    ) {
      throw new ApiError(409, 'FORM_DRAFT_REVISION_CONFLICT', 'The form changed');
    }

    const verdict = evaluatePublishability(draft, event);
    const published = currentVersionOf(event);
    return delay({
      publishable: verdict.publishable,
      errors: verdict.errors,
      warnings: verdict.warnings,
      draftRevision: draft?.revision ?? null,
      publishedVersionNumber: published?.versionNumber ?? null,
      hasUnpublishedChanges: hasUnpublishedChanges(
        draft?.revision ?? null,
        published?.sourceDraftRevision ?? null,
      ),
    });
  },

  async publishForm(
    eventId: string,
    expectedDraftRevision: number,
  ): Promise<PublishFormResponse> {
    const admin = requireAuth();
    seedEvents();
    const event = findEvent(eventId);

    const stored = formDrafts.find((candidate) => candidate.eventId === eventId);
    if (!stored) throw new ApiError(404, 'FORM_DRAFT_NOT_FOUND', 'No draft');
    const draft = assembleDraft(stored);

    if (draft.revision !== expectedDraftRevision) {
      throw new ApiError(409, 'FORM_DRAFT_REVISION_CONFLICT', 'The form changed');
    }

    const own = formVersions.filter((version) => version.eventId === eventId);
    // Asked of EVERY version, not only the newest: the server's unique index on
    // (event_id, source_draft_revision) allows exactly one per revision.
    const alreadyFrozen = own.find(
      (version) => version.sourceDraftRevision === draft.revision,
    );
    if (alreadyFrozen) {
      throw new ApiError(409, 'FORM_NO_UNPUBLISHED_CHANGES', 'Nothing new to publish', {
        versionNumber: String(alreadyFrozen.versionNumber),
      });
    }
    const latest = own.sort((a, b) => b.versionNumber - a.versionNumber)[0];

    const verdict = evaluatePublishability(draft, event);
    if (!verdict.publishable) {
      throw new ApiError(422, 'FORM_DRAFT_NOT_PUBLISHABLE', 'Not ready', {
        issues: String(verdict.errors.length),
      });
    }

    const at = new Date().toISOString();
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const version: MockVersion = {
      id: crypto.randomUUID(),
      eventId,
      versionNumber,
      sourceDraftRevision: draft.revision,
      publishedBy: admin.id,
      publishedAt: at,
      createdAt: at,
      // A COPY: editing the draft afterwards cannot reach it.
      steps: freezeSteps(draft.steps),
      snapshot: buildFormSnapshot(draft, { versionNumber, publishedAt: at }),
    };
    formVersions.push(version);
    event.publishedFormVersionId = version.id;

    return delay({
      version: toVersionShape(version),
      // The draft is untouched: its revision does not move, so the form is
      // immediately "up to date" rather than dirty.
      draft: assembleDraft(stored),
      eventId,
      publishedVersionId: version.id,
    });
  },

  async listFormVersions(eventId: string): Promise<EventFormVersionListResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);

    const items = formVersions
      .filter((version) => version.eventId === eventId)
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        sourceDraftRevision: version.sourceDraftRevision,
        publishedBy: version.publishedBy,
        publishedByName: adminUsers.find((a) => a.id === version.publishedBy)?.displayName ?? null,
        publishedAt: version.publishedAt,
        currentPublished: version.id === event.publishedFormVersionId,
        stepCount: version.steps.length,
        questionCount: version.steps.reduce((sum, step) => sum + step.questions.length, 0),
      }));

    return delay({ items, currentVersionId: event.publishedFormVersionId ?? null });
  },

  async getFormVersion(
    eventId: string,
    versionId: string,
  ): Promise<EventFormVersionDetailResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    // Scoped: a version id from another event is "not found".
    const version = formVersions.find((v) => v.id === versionId && v.eventId === eventId);
    if (!version) throw new ApiError(404, 'FORM_VERSION_NOT_FOUND', 'Version not found');

    return delay({
      version: toVersionShape(version),
      currentPublished: version.id === event.publishedFormVersionId,
      snapshot: version.snapshot,
    });
  },

  // --- Participants and entries --------------------------------------------

  async createEventEntry(
    eventId: string,
    answers: SubmittedAnswer[],
  ): Promise<CreateEventEntryResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);

    if (answers.length > ANSWERS_PER_ENTRY_MAX) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Too many answers');
    }

    // The event must be OPEN and inside its registration window — the same rule
    // the public flow will obey, applied here so nothing has to be tightened
    // later once rows exist that were written under a looser one.
    const window = entryWindowProblem(event, new Date().toISOString());
    if (window !== null) {
      throw new ApiError(
        409,
        'EVENT_NOT_ACCEPTING_ENTRIES',
        'This event is not accepting entries',
        { reason: window },
      );
    }

    // Resolved, not trusted: the pointer must name a version of THIS event that
    // actually has questions.
    const version = currentVersionOf(event);
    if (!version) {
      throw new ApiError(
        409,
        'FORM_VERSION_REQUIRED',
        'This event has no published form to fill in',
        { reason: event.publishedFormVersionId ? 'empty' : 'none' },
      );
    }

    // Validated against the FROZEN version, never the draft.
    const submission = validateSubmission(version.steps, answers);
    if (!submission.ok) refuseSubmission(submission);

    const profile = extractParticipantProfile(submission.accepted);
    if (!profile.ok) {
      throw new ApiError(500, 'FORM_VERSION_INVALID', 'The published form could not be read', {
        reason: 'system_fields',
      });
    }

    const normalized = normalizeEmail(profile.profile.email);
    const existing = participants.find((candidate) => candidate.normalizedEmail === normalized);

    if (existing) {
      // Two different dates of birth for one address is never resolved
      // silently: guessing which is right would either corrupt a record or
      // decide somebody's eligibility on data they did not give.
      if (
        existing.dateOfBirth !== null &&
        profile.profile.dateOfBirth !== null &&
        existing.dateOfBirth !== profile.profile.dateOfBirth
      ) {
        throw new ApiError(
          409,
          'PARTICIPANT_IDENTITY_CONFLICT',
          'This email is already registered with different details',
          { field: 'dateOfBirth' },
        );
      }

      const already = eventEntries.find(
        (entry) => entry.eventId === eventId && entry.participantId === existing.id,
      );
      if (already) {
        throw new ApiError(
          409,
          'PARTICIPANT_ALREADY_ENTERED',
          'This person has already entered this event',
          { entryId: already.id },
        );
      }
    }

    // ONE instant for the whole operation, exactly as the server does: the
    // window, the event's local date, the age and `submittedAt` all come from
    // it, so a submission at local midnight cannot be judged against one day
    // and recorded against another.
    const now = mockNow();
    const at = now.toISOString();

    // A zone the runtime cannot resolve is refused rather than silently
    // becoming UTC — which is a different day for five hours every night.
    if (!isValidTimeZone(event.timezone)) {
      throw new ApiError(500, 'FORM_VERSION_INVALID', 'The published form could not be read', {
        reason: 'event_timezone',
      });
    }

    // The SAME shared rules the backend runs. Reimplementing them here is how a
    // mock teaches a contract that does not exist.
    const outcome = evaluateAgeEligibility({
      minimumAge: event.minimumAge,
      dateOfBirth: profile.profile.dateOfBirth,
      formAsksForDateOfBirth: version.steps.some((step) =>
        step.questions.some((q) => q.systemField === 'DATE_OF_BIRTH' && q.active),
      ),
      referenceCivilDate: civilDateInEventZone(now, event.timezone),
    });
    if (outcome.kind === 'rejected') {
      // Broken input, not a person who failed a rule: no entry is recorded.
      if (outcome.reasonCode === 'FORM_INVALID') {
        throw new ApiError(500, 'FORM_VERSION_INVALID', 'The published form could not be read', {
          reason: 'no_date_of_birth',
        });
      }
      if (outcome.reasonCode === 'DATE_OF_BIRTH_REQUIRED') {
        throw new ApiError(422, 'DATE_OF_BIRTH_REQUIRED', 'This event requires a date of birth');
      }
      throw new ApiError(400, 'DATE_OF_BIRTH_INVALID', 'That date of birth is not a possible one', {
        problem: outcome.problem ?? 'INVALID',
      });
    }
    const decision = outcome.decision;

    let participant: Participant;
    if (existing) {
      // A form that did not ask cannot erase what an earlier one recorded.
      existing.email = profile.profile.email;
      existing.firstName = profile.profile.firstName;
      existing.lastName = profile.profile.lastName;
      existing.phone = profile.profile.phone ?? existing.phone;
      existing.dateOfBirth = profile.profile.dateOfBirth ?? existing.dateOfBirth;
      existing.updatedAt = at;
      participant = existing;
    } else {
      participant = {
        id: crypto.randomUUID(),
        email: profile.profile.email,
        normalizedEmail: normalized,
        firstName: profile.profile.firstName,
        lastName: profile.profile.lastName,
        phone: profile.profile.phone,
        dateOfBirth: profile.profile.dateOfBirth,
        createdAt: at,
        updatedAt: at,
      };
      participants.push(participant);
    }

    const entryId = crypto.randomUUID();
    const entry: MockEntry = {
      id: entryId,
      eventId,
      participantId: participant.id,
      formVersionId: version.id,
      // Born decided, in the same act that creates it.
      status: statusForDecision(decision),
      calculatedAge: decision.calculatedAge,
      ageEligible: decision.ageEligible,
      overallEligible: decision.overallEligible,
      eligibilityReason: decision.reasonCode,
      submittedAt: at,
      createdAt: at,
      updatedAt: at,
      answers: buildMockAnswers(entryId, submission.accepted),
    };
    eventEntries.push(entry);

    return delay({
      entry: snapshotEntry(entry),
      participant: snapshotParticipant(participant),
      answerCount: entry.answers.length,
    });
  },

  async listEventEntries(
    eventId: string,
    params: { page?: number; pageSize?: number; search?: string } = {},
  ): Promise<EventEntryListResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 25;
    const search = (params.search ?? '').trim().toLowerCase();

    const own = eventEntries
      .filter((entry) => entry.eventId === eventId)
      .filter((entry) => {
        if (!search) return true;
        const participant = participants.find((candidate) => candidate.id === entry.participantId);
        if (!participant) return false;
        return (
          participant.firstName.toLowerCase().includes(search) ||
          participant.lastName.toLowerCase().includes(search) ||
          participant.email.toLowerCase().includes(search)
        );
      })
      .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

    const items: EventEntrySummary[] = own
      .slice((page - 1) * pageSize, page * pageSize)
      .map((entry) => {
        const participant = participants.find(
          (candidate) => candidate.id === entry.participantId,
        )!;
        const version = formVersions.find((candidate) => candidate.id === entry.formVersionId)!;
        return {
          entryId: entry.id,
          participantId: participant.id,
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          submittedAt: entry.submittedAt,
          status: entry.status,
          calculatedAge: entry.calculatedAge,
          overallEligible: entry.overallEligible,
          eligibilityReason: entry.eligibilityReason,
          formVersionId: version.id,
          formVersionNumber: version.versionNumber,
          answerCount: entry.answers.length,
        };
      });

    return delay({
      items,
      total: own.length,
      page,
      pageSize,
      eventStatus: event.status,
      acceptingEntries: entryWindowProblem(event, new Date().toISOString()) === null,
    });
  },

  async getEventEntry(eventId: string, entryId: string): Promise<EventEntryDetail> {
    requireAuth();
    seedEvents();
    findEvent(eventId);

    // Scoped: an entry id from another event is "not found", never a read.
    const entry = eventEntries.find(
      (candidate) => candidate.id === entryId && candidate.eventId === eventId,
    );
    if (!entry) throw new ApiError(404, 'EVENT_ENTRY_NOT_FOUND', 'Entry not found');

    const participant = participants.find((candidate) => candidate.id === entry.participantId)!;
    const version = formVersions.find((candidate) => candidate.id === entry.formVersionId)!;

    return delay({
      entry: snapshotEntry(entry),
      participant: snapshotParticipant(participant),
      formVersion: {
        id: version.id,
        versionNumber: version.versionNumber,
        publishedAt: version.publishedAt,
      },
      answers: snapshotAnswers(entry),
    });
  },

  async getPublishedForm(eventId: string): Promise<PublishedFormResponse> {
    requireAuth();
    seedEvents();
    const event = findEvent(eventId);
    const version = currentVersionOf(event);
    return delay({ publishedVersion: version ? toVersionShape(version) : null });
  },
};
