// Housing status collected on the /events lead form.
export type HousingStatus = 'OWNER' | 'RENTER';

// Highest level of education collected on the /events lead form.
export type EducationLevel =
  | 'HIGH_SCHOOL'
  | 'SOME_COLLEGE'
  | 'ASSOCIATE'
  | 'BACHELORS'
  | 'MASTERS'
  | 'DOCTORATE'
  | 'OTHER';

export const EDUCATION_LEVELS: EducationLevel[] = [
  'HIGH_SCHOOL',
  'SOME_COLLEGE',
  'ASSOCIATE',
  'BACHELORS',
  'MASTERS',
  'DOCTORATE',
  'OTHER',
];

export const HOUSING_STATUSES: HousingStatus[] = ['OWNER', 'RENTER'];

// Payload submitted by the /events data-collection form. All fields here are
// required for a NEW submission (the multi-step form validates each one).
export interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  highestLevelOfEducation: EducationLevel;
  age: number;
  zip: string;
  // City may be auto-populated from the zip; it is optional and never blocks
  // submission if it could not be resolved.
  city?: string;
  housingStatus: HousingStatus;
  ownsVehicle: boolean;
  isBusinessOwner: boolean;
}

export interface RegisterResponse {
  id: string;
  participantNumber: number;
  createdAt: string;
}

// A stored lead. The survey fields are optional here (not on RegisterRequest)
// so legacy/imported rows that pre-date these columns still read cleanly.
export interface Attendee {
  id: string;
  participantNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  highestLevelOfEducation?: EducationLevel;
  age?: number;
  zip?: string;
  city?: string;
  housingStatus?: HousingStatus;
  ownsVehicle?: boolean;
  isBusinessOwner?: boolean;
  createdAt: string;
}

export interface AttendeeListResponse {
  items: Attendee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface YesNoBreakdown {
  yes: number;
  no: number;
  unknown: number;
}

export interface HousingBreakdown {
  OWNER: number;
  RENTER: number;
  unknown: number;
}

export type EducationBreakdown = Record<EducationLevel, number>;

export interface Metrics {
  total: number;
  leadsToday: number;
  byHousingStatus: HousingBreakdown;
  byVehicle: YesNoBreakdown;
  byBusinessOwner: YesNoBreakdown;
  byEducation: EducationBreakdown;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Administrative identity
//
// Every admin is an individual account. `AdminUser` is the PUBLIC shape: it
// never carries `password_hash`, `token_hash` or any other secret, so it is
// safe to return from the API verbatim.
// ---------------------------------------------------------------------------

export type AdminRole = 'ADMIN';

export const ADMIN_ROLES: AdminRole[] = ['ADMIN'];

export type AdminStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export const ADMIN_STATUSES: AdminStatus[] = ['ACTIVE', 'SUSPENDED', 'DISABLED'];

/** Public representation of an administrator. Never contains secrets. */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/**
 * Public representation of a session. The plaintext token is NEVER part of
 * this shape — it is handed to the client once, in a Set-Cookie header.
 */
export interface AdminSession {
  id: string;
  adminUserId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastSeenAt?: string;
}

/**
 * The authenticated actor resolved by the middleware and exposed to every
 * protected handler through `ctx.data.admin`.
 */
export interface AuthenticatedAdmin {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: AdminStatus;
  sessionId: string;
}

export interface AdminLoginInput {
  email: string;
  password: string;
}

export interface AdminLoginResponse {
  admin: AdminUser;
  expiresAt: string;
}

export interface AdminMeResponse {
  admin: AdminUser;
}

export interface AdminLogoutResponse {
  ok: true;
}

export type RaffleDrawRequest =
  | { mode: 'random' }
  | { mode: 'manual'; participantNumber: number };

export interface RaffleDrawResponse {
  winner: Attendee;
  drawnAt: string;
  emailSent: boolean;
}

export interface CurrentRaffleResponse {
  winner: Attendee;
  drawnAt: string;
}

// ---------------------------------------------------------------------------
// Audit trail
//
// `audit_logs` is append-only from the application: there is no update, no
// delete and no purge endpoint. Every administrative action that matters can be
// attributed to an actor, a request and a moment.
// ---------------------------------------------------------------------------

/**
 * Catalogue of auditable actions.
 *
 * Handlers pick from this union rather than passing free strings, so the set
 * stays greppable and a typo becomes a compile error. Entries for later phases
 * are declared now so the vocabulary is fixed up front; only the auth and audit
 * ones are emitted today.
 */
export const AUDIT_ACTIONS = [
  // Authentication (phase 1 surface, audited here in phase 2)
  'ADMIN_LOGIN_SUCCEEDED',
  'ADMIN_LOGIN_FAILED',
  'ADMIN_LOGOUT',
  'ADMIN_SESSION_REVOKED',
  'ADMIN_ACCESS_DENIED',
  // Audit itself
  'AUDIT_LOG_VIEWED',
  'AUDIT_LOG_EXPORTED',
  // Reserved — declared, not yet emitted
  'EVENT_CREATED',
  'EVENT_UPDATED',
  'EVENT_PUBLISHED',
  'EVENT_OPENED',
  'EVENT_CLOSED',
  'EVENT_MARKED_DRAW_READY',
  'EVENT_CANCELLED',
  'EVENT_ARCHIVED',
  'EVENT_DELETED',
  'EVENT_DUPLICATED',
  'PRIZE_CREATED',
  'PRIZE_UPDATED',
  'PRIZE_ACTIVATED',
  'PRIZE_DEACTIVATED',
  'PRIZE_ARCHIVED',
  'PRIZE_DELETED',
  'PRIZES_REORDERED',
  'FORM_DRAFT_CREATED',
  'FORM_DRAFT_UPDATED',
  'FORM_STEP_CREATED',
  'FORM_STEP_UPDATED',
  'FORM_STEP_DELETED',
  'FORM_STEPS_REORDERED',
  'FORM_QUESTION_CREATED',
  'FORM_QUESTION_UPDATED',
  'FORM_QUESTION_DELETED',
  'FORM_QUESTIONS_REORDERED',
  'FORM_OPTION_CREATED',
  'FORM_OPTION_UPDATED',
  'FORM_OPTION_DELETED',
  'FORM_OPTIONS_REORDERED',
  'FORM_VERSION_PUBLISHED',
  // Reserved: reading a version is not a change, and auditing every read of a
  // published form would drown the trail that matters. Declared so a later
  // policy can emit it without a migration.
  'FORM_VERSION_VIEWED',
  // Participants and entries (phase 7)
  'PARTICIPANT_CREATED',
  'PARTICIPANT_UPDATED',
  'EVENT_ENTRY_CREATED',
  // Reserved: reading a list of entries is not a change, and auditing every
  // read would drown the trail that matters. Emitted only for the DETAIL of one
  // entry, which is where the personal data actually is.
  'EVENT_ENTRY_VIEWED',
  'PARTICIPANTS_EXPORTED',
  'DRAW_STARTED',
  'DRAW_COMPLETED',
  'DRAW_FAILED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  // In use today
  'ADMIN_USER',
  'ADMIN_SESSION',
  'AUDIT_LOG',
  'SYSTEM',
  // Reserved — declared, not yet emitted
  'EVENT',
  'PRIZE',
  'FORM',
  'FORM_STEP',
  'FORM_QUESTION',
  'FORM_OPTION',
  'FORM_VERSION',
  'PARTICIPANT',
  'EVENT_ENTRY',
  'DRAW',
  'DRAW_ASSIGNMENT',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/** Arbitrary structured context. Always redacted before storage. */
export type AuditMetadata = Record<string, unknown>;

/** The administrator responsible for an action, when there is one. */
export interface AuditActor {
  id: string;
  email: string;
  displayName: string;
}

/** A stored audit entry as returned by the API. */
export interface AuditLog {
  id: string;
  /** Null for pre-authentication events such as a failed login. */
  actorAdminId: string | null;
  /** Denormalised for display; null when the admin was deleted. */
  actorEmail: string | null;
  actorDisplayName: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  eventId: string | null;
  previousData: unknown | null;
  newData: unknown | null;
  metadata: unknown | null;
  /** SHA-256 of the client IP. The raw address is never stored. */
  ipHash: string | null;
  userAgent: string | null;
  requestId: string;
  createdAt: string;
}

/** Input accepted by `AuditService.record`. */
export interface AuditWriteInput {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  eventId?: string | null;
  actor?: AuditActor | null;
  previousData?: unknown;
  newData?: unknown;
  metadata?: AuditMetadata | null;
}

export interface AuditListQuery {
  page: number;
  pageSize: number;
  actorAdminId: string | null;
  action: AuditAction | null;
  entityType: AuditEntityType | null;
  entityId: string | null;
  eventId: string | null;
  from: string | null;
  to: string | null;
}

export interface AuditListResponse {
  items: AuditLog[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Events
//
// A NEW domain, unrelated to the legacy `attendees` lead capture that happens
// to live behind a route called `/events`.
// ---------------------------------------------------------------------------

export type {
  EventStatus,
  EventTransitionAction,
  EventEditableField,
} from './eventLifecycle.ts';

/** A full event as returned by the admin API. */
export interface Event {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  bannerUrl: string | null;
  locationName: string | null;
  timezone: string;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  minimumAge: number | null;
  maxEntriesPerIdentity: number;
  status: import('./eventLifecycle.ts').EventStatus;
  confirmationTitle: string | null;
  confirmationMessage: string | null;
  ineligibleTitle: string | null;
  ineligibleMessage: string | null;
  /** Optimistic-concurrency token; must be echoed back on every mutation. */
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  archivedAt: string | null;
  /**
   * The published form this event serves. Null until it has published one.
   *
   * Set only by publishing, which writes the id it has just created — SQLite
   * cannot express "must belong to THIS event", so the application owns that
   * half of the constraint.
   */
  publishedFormVersionId: string | null;
}

/** Row shape used by the listing table. */
export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  status: import('./eventLifecycle.ts').EventStatus;
  timezone: string;
  registrationOpensAt: string | null;
  startsAt: string | null;
  revision: number;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateEventInput {
  name: string;
  slug?: string;
  timezone?: string;
  description?: string | null;
  bannerUrl?: string | null;
  locationName?: string | null;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  minimumAge?: number | null;
  maxEntriesPerIdentity?: number;
  confirmationTitle?: string | null;
  confirmationMessage?: string | null;
  ineligibleTitle?: string | null;
  ineligibleMessage?: string | null;
}

/** Partial update. `status` is deliberately absent — see the transition endpoints. */
export type UpdateEventInput = Partial<Omit<CreateEventInput, 'name'>> & {
  name?: string;
  expectedRevision: number;
};

export interface DuplicateEventInput {
  name?: string;
  slug?: string;
  /** Dates are NOT copied unless asked for, and only while still in the future. */
  copyDates?: boolean;
  expectedRevision?: number;
}

export type EventArchivedFilter = 'active' | 'archived' | 'all';
export type EventSortKey = 'createdAt' | 'updatedAt' | 'name' | 'startsAt';
export type SortDirection = 'asc' | 'desc';

export interface EventListQuery {
  page: number;
  pageSize: number;
  status: import('./eventLifecycle.ts').EventStatus | null;
  search: string | null;
  archived: EventArchivedFilter;
  sort: EventSortKey;
  direction: SortDirection;
}

export interface EventListResponse {
  items: EventSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Detail response: the event plus what may be done to it right now. */
export interface EventDetailResponse {
  event: Event;
  /** Actions the state permits AND whose data preconditions are satisfied. */
  availableActions: import('./eventLifecycle.ts').EventTransitionAction[];
  /** Actions the state permits but that are blocked by missing configuration. */
  blockedActions: Array<{
    action: import('./eventLifecycle.ts').EventTransitionAction;
    missingFields: string[];
  }>;
  editableFields: string[];
  canDelete: boolean;
  actors: {
    createdBy: { id: string; displayName: string | null; email: string | null };
    updatedBy: { id: string; displayName: string | null; email: string | null };
  };
}

export interface EventTransitionResponse {
  event: Event;
}

// ---------------------------------------------------------------------------
// Event prizes
//
// Fully configurable per event. Nothing is hardcoded: a "Gift Card" is a row a
// client created, not a value this system knows about.
// ---------------------------------------------------------------------------

export type {
  PrizeStatus,
  PrizeTransitionAction,
  PrizeCapability,
  PrizeEditableField,
} from './prizeLifecycle.ts';

export interface EventPrize {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  quantity: number;
  sortOrder: number;
  status: import('./prizeLifecycle.ts').PrizeStatus;
  /** Optimistic-concurrency token, per prize. */
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Row shape for the listing table. */
export interface EventPrizeSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  sortOrder: number;
  status: import('./prizeLifecycle.ts').PrizeStatus;
  revision: number;
  updatedAt: string;
}

export interface CreateEventPrizeInput {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  quantity: number;
  /** Omitted means "append to the end". */
  sortOrder?: number;
}

/** Partial patch. Status and order change through their own actions. */
export interface UpdateEventPrizeInput {
  expectedRevision: number;
  name?: string;
  description?: string | null;
  imageUrl?: string | null;
  quantity?: number;
}

export type PrizeArchivedFilter = 'active' | 'archived' | 'all';
export type PrizeSortKey = 'sortOrder' | 'name' | 'quantity' | 'createdAt' | 'updatedAt';

export interface EventPrizeListQuery {
  page: number;
  pageSize: number;
  status: import('./prizeLifecycle.ts').PrizeStatus | null;
  archived: PrizeArchivedFilter;
  search: string | null;
  sort: PrizeSortKey;
  direction: SortDirection;
}

/**
 * Counts for the admin summary. Informative only: no winner or assignment
 * exists yet, so these describe configuration, not outcomes.
 */
export interface EventPrizeSummaryCounts {
  totalPrizes: number;
  activePrizes: number;
  inactivePrizes: number;
  archivedPrizes: number;
  totalActiveUnits: number;
}

export interface EventPrizeListResponse {
  items: EventPrizeSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: EventPrizeSummaryCounts;
  eventStatus: import('./eventLifecycle.ts').EventStatus;
}

export interface EventPrizeDetailResponse {
  prize: EventPrize;
  allowedActions: import('./prizeLifecycle.ts').PrizeTransitionAction[];
  editableFields: string[];
  canDelete: boolean;
  eventStatus: import('./eventLifecycle.ts').EventStatus;
}

export interface ReorderEventPrizeItem {
  prizeId: string;
  expectedRevision: number;
  sortOrder: number;
}

export interface ReorderEventPrizesInput {
  items: ReorderEventPrizeItem[];
}

export interface PrizeMutationResponse {
  prize: EventPrize;
}

// ---------------------------------------------------------------------------
// Registration forms
//
// The form is DATA. There is no column named after any question a client asks:
// a question is a row, its choices are rows, and its position is an integer.
// This phase builds and stores the DRAFT only — publishing a frozen version is
// the next phase's job.
// ---------------------------------------------------------------------------

export type {
  FormOwnerType,
  FormQuestionType,
  FormSystemField,
  FormPreviewProblemCode,
} from './formLifecycle.ts';

/** Per-type answer constraints. Every key is optional and type-appropriate. */
export interface FormQuestionValidation {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  integerOnly?: boolean;
  minDate?: string;
  maxDate?: string;
  minSelected?: number;
  maxSelected?: number;
}

export interface FormQuestionOption {
  id: string;
  questionId: string;
  value: string;
  label: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FormQuestion {
  id: string;
  ownerType: import('./formLifecycle.ts').FormOwnerType;
  ownerId: string;
  stepId: string;
  /** Stable answer key; unique within a form. */
  key: string;
  systemField: import('./formLifecycle.ts').FormSystemField;
  type: import('./formLifecycle.ts').FormQuestionType;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  active: boolean;
  exportable: boolean;
  sortOrder: number;
  validation: FormQuestionValidation | null;
  options: FormQuestionOption[];
  createdAt: string;
  updatedAt: string;
}

export interface FormStep {
  id: string;
  ownerType: import('./formLifecycle.ts').FormOwnerType;
  ownerId: string;
  title: string;
  description: string | null;
  sortOrder: number;
  questions: FormQuestion[];
  createdAt: string;
  updatedAt: string;
}

/** The whole working copy, assembled: the shape the builder renders from. */
export interface EventFormDraft {
  id: string;
  eventId: string;
  /** Optimistic-concurrency token for the WHOLE form. */
  revision: number;
  steps: FormStep[];
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EventFormDraftResponse {
  /**
   * Null until the form is created. Reading never creates one — that is an
   * explicit POST, so a prefetch or a double render cannot bring a form into
   * existence (and with it, an event that can no longer be deleted).
   */
  draft: EventFormDraft | null;
  eventStatus: import('./eventLifecycle.ts').EventStatus;
  /** False once the event has closed; the builder renders read-only. */
  editable: boolean;
  /** System fields not yet placed on this form, offered as one-click adds. */
  availableSystemFields: import('./formLifecycle.ts').FormSystemField[];
  /** Null until the form has been published at least once. */
  publishedVersionNumber: number | null;
  publishedVersionId: string | null;
  publishedAt: string | null;
  /** Revision comparison, not a diff: see `hasUnpublishedChanges`. */
  hasUnpublishedChanges: boolean;
}

export interface CreateFormStepInput {
  expectedRevision: number;
  title: string;
  description?: string | null;
}

export interface UpdateFormStepInput {
  expectedRevision: number;
  title?: string;
  description?: string | null;
}

export interface CreateFormQuestionInput {
  expectedRevision: number;
  stepId: string;
  type: import('./formLifecycle.ts').FormQuestionType;
  label: string;
  /** Derived from the label when omitted. Fixed for a system field. */
  key?: string;
  systemField?: import('./formLifecycle.ts').FormSystemField;
  description?: string | null;
  placeholder?: string | null;
  required?: boolean;
  active?: boolean;
  exportable?: boolean;
  validation?: FormQuestionValidation | null;
  options?: Array<{ value: string; label: string }>;
}

export interface UpdateFormQuestionInput {
  expectedRevision: number;
  label?: string;
  key?: string;
  type?: import('./formLifecycle.ts').FormQuestionType;
  description?: string | null;
  placeholder?: string | null;
  required?: boolean;
  active?: boolean;
  exportable?: boolean;
  validation?: FormQuestionValidation | null;
  /** Moving a question to another step is an ordinary patch. */
  stepId?: string;
}

export interface CreateFormOptionInput {
  expectedRevision: number;
  value: string;
  label: string;
  active?: boolean;
}

export interface UpdateFormOptionInput {
  expectedRevision: number;
  value?: string;
  label?: string;
  active?: boolean;
}

export interface UpdateFormDraftInput {
  expectedRevision: number;
}

export interface ReorderFormItem {
  id: string;
  sortOrder: number;
}

export interface ReorderFormInput {
  expectedRevision: number;
  items: ReorderFormItem[];
}

/** Reordering questions also states which step the ordering belongs to. */
export interface ReorderFormQuestionsInput extends ReorderFormInput {
  stepId: string;
}

/** Every form mutation answers with the whole draft: one shape, always fresh. */
export interface FormDraftMutationResponse {
  draft: EventFormDraft;
}

export interface FormPreviewProblem {
  code: import('./formLifecycle.ts').FormPreviewProblemCode;
  stepId: string | null;
  questionId: string | null;
  detail: string;
}

/**
 * A rendering of the draft as a participant would meet it, plus everything
 * publishing will later refuse. Nothing is stored and no participant exists.
 */
export type {
  FormPublishIssue,
  FormPublishIssueCode,
  FormPublishValidation,
  FormSchemaSnapshot,
} from './formPublishing.ts';

/** A published, immutable form. */
export interface EventFormVersion {
  id: string;
  eventId: string;
  versionNumber: number;
  /** The draft revision this froze; the basis of the "unpublished changes" flag. */
  sourceDraftRevision: number;
  publishedBy: string;
  publishedAt: string;
  createdAt: string;
  /** The frozen structure, read from the normalized VERSION rows. */
  steps: FormStep[];
}

/** Row shape for the history list. */
export interface EventFormVersionSummary {
  id: string;
  versionNumber: number;
  sourceDraftRevision: number;
  publishedBy: string;
  publishedByName: string | null;
  publishedAt: string;
  /** True for the version the event currently points at. */
  currentPublished: boolean;
  stepCount: number;
  questionCount: number;
}

export interface EventFormVersionListResponse {
  items: EventFormVersionSummary[];
  /** Null until something has been published. */
  currentVersionId: string | null;
}

export interface EventFormVersionDetailResponse {
  version: EventFormVersion;
  currentPublished: boolean;
  /** The stored JSON evidence, alongside the normalized rows it must match. */
  snapshot: import('./formPublishing.ts').FormSchemaSnapshot;
}

/** What the event currently serves, if anything. */
export interface PublishedFormResponse {
  publishedVersion: EventFormVersion | null;
}

export interface PublishFormInput {
  /** The revision the operator confirmed. Publishing anything else is refused. */
  expectedDraftRevision: number;
}

export interface PublishFormResponse {
  version: EventFormVersion;
  /** The draft is untouched by publishing and stays editable. */
  draft: EventFormDraft;
  eventId: string;
  publishedVersionId: string;
}

export interface FormPublishValidationResponse {
  publishable: boolean;
  errors: import('./formPublishing.ts').FormPublishIssue[];
  warnings: import('./formPublishing.ts').FormPublishIssue[];
  /** The revision the verdict was computed against. */
  draftRevision: number | null;
  publishedVersionNumber: number | null;
  hasUnpublishedChanges: boolean;
}

export interface FormPreviewResponse {
  eventId: string;
  revision: number;
  steps: Array<{
    id: string;
    title: string;
    description: string | null;
    questions: Array<{
      id: string;
      key: string;
      type: import('./formLifecycle.ts').FormQuestionType;
      label: string;
      description: string | null;
      placeholder: string | null;
      required: boolean;
      validation: FormQuestionValidation | null;
      options: Array<{ value: string; label: string }>;
    }>;
  }>;
  problems: FormPreviewProblem[];
}

// ---------------------------------------------------------------------------
// Participants, entries and answers (phase 7)
//
// Three distinct things, never collapsed:
//
//   Participant — WHO somebody is. One row per identity, reused across events.
//   EventEntry  — THAT they took part in one event, bound to one frozen form
//                 version.
//   Answer      — WHAT they said, question by question.
// ---------------------------------------------------------------------------

export type {
  EventEntryStatus,
  EntryWindowProblem,
} from './entryLifecycle.ts';

export type {
  EligibilityDecision,
  EligibilityReasonCode,
} from './eligibility.ts';

export type {
  AnswerValue,
  AnswerType,
  AnswerProblem,
  SubmittedAnswer,
  ParticipantProfile,
} from './formAnswers.ts';

/** A reusable identity. Identified by `normalizedEmail`, and nothing else. */
export interface Participant {
  id: string;
  /** Presentable form, as the person typed it. */
  email: string;
  /** Canonical form. Carries the uniqueness guarantee. */
  normalizedEmail: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  /** A civil date (`YYYY-MM-DD`), never an instant. Null when never asked. */
  dateOfBirth: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One identity's participation in one event. */
export interface EventEntry {
  id: string;
  eventId: string;
  participantId: string;
  /** The exact version they filled in. What keeps an old entry readable. */
  formVersionId: string;
  status: import('./entryLifecycle.ts').EventEntryStatus;
  /** Null until the eligibility phase computes them. */
  calculatedAge: number | null;
  ageEligible: boolean | null;
  overallEligible: boolean | null;
  eligibilityReason: import('./eligibility.ts').EligibilityReasonCode | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** One answer, with the snapshot that makes it readable without a join. */
export interface EventEntryAnswer {
  id: string;
  entryId: string;
  questionId: string;
  questionKey: string;
  /** The label as it read when the answer was given. */
  questionLabel: string;
  type: import('./formAnswers.ts').AnswerType;
  value: import('./formAnswers.ts').AnswerValue;
}

/**
 * What creating an entry accepts: answers, and nothing else.
 *
 * No participant object (the form already asks), no version id (the server
 * resolves the one the event currently serves), no status, no timestamps, no
 * eligibility, no snapshots. Everything else is derived, because everything
 * else is something a caller could get wrong or lie about.
 */
export interface CreateEventEntryInput {
  answers: import('./formAnswers.ts').SubmittedAnswer[];
}

/** Row shape for the participants list of an event. */
export interface EventEntrySummary {
  entryId: string;
  participantId: string;
  firstName: string;
  lastName: string;
  email: string;
  submittedAt: string;
  status: import('./entryLifecycle.ts').EventEntryStatus;
  /** Age AT SUBMISSION, in the event's timezone. Never recomputed. */
  calculatedAge: number | null;
  overallEligible: boolean | null;
  eligibilityReason: import('./eligibility.ts').EligibilityReasonCode | null;
  formVersionId: string;
  formVersionNumber: number;
  answerCount: number;
}

export interface EventEntryListQuery {
  page: number;
  pageSize: number;
  /** Matches a name or an email. No dynamic answer filters in this phase. */
  search: string | null;
}

export interface EventEntryListResponse {
  items: EventEntrySummary[];
  total: number;
  page: number;
  pageSize: number;
  eventStatus: import('./eventLifecycle.ts').EventStatus;
  /** Whether the event would accept a new entry right now. */
  acceptingEntries: boolean;
}

/** One entry in full, with the identity and the version it belongs to. */
export interface EventEntryDetail {
  entry: EventEntry;
  participant: Participant;
  formVersion: {
    id: string;
    versionNumber: number;
    publishedAt: string;
  };
  /** Ordered by step position, then question position — never insertion order. */
  answers: EventEntryAnswer[];
}

export interface CreateEventEntryResponse {
  entry: EventEntry;
  participant: Participant;
  answerCount: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'EMAIL_EXISTS'
  | 'INVALID_PASSWORD'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'WINNER_NOT_FOUND'
  | 'NO_ATTENDEES'
  | 'RAFFLE_ALREADY_DRAWN'
  | 'RATE_LIMIT'
  | 'PENDING'
  | 'SERVER_ERROR'
  // Administrative identity (phase 1)
  | 'INVALID_CREDENTIALS'
  | 'ADMIN_DISABLED'
  | 'ADMIN_SUSPENDED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_INVALID'
  | 'EMAIL_ALREADY_EXISTS'
  | 'PASSWORD_REQUIREMENTS_NOT_MET'
  | 'UNSUPPORTED_MEDIA_TYPE'
  // Payload and query handling (phase 2)
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_QUERY'
  // Events (phase 3)
  | 'EVENT_NOT_FOUND'
  | 'EVENT_SLUG_EXISTS'
  | 'EVENT_SLUG_RESERVED'
  | 'EVENT_INVALID_SLUG'
  | 'EVENT_INVALID_TRANSITION'
  | 'EVENT_INVALID_DATE_RANGE'
  | 'EVENT_REQUIRED_FIELDS_MISSING'
  | 'EVENT_CANNOT_BE_EDITED'
  | 'EVENT_CANNOT_BE_DELETED'
  | 'EVENT_ALREADY_ARCHIVED'
  | 'EVENT_ALREADY_CANCELLED'
  | 'EVENT_NOT_READY'
  | 'EVENT_DUPLICATE_FAILED'
  | 'EVENT_REVISION_CONFLICT'
  | 'EVENT_NOT_READY'
  // Prizes (phase 4)
  | 'PRIZE_NOT_FOUND'
  | 'PRIZE_INVALID_STATUS'
  | 'PRIZE_INVALID_QUANTITY'
  | 'PRIZE_LIMIT_REACHED'
  | 'PRIZE_CANNOT_BE_EDITED'
  | 'PRIZE_CANNOT_BE_DELETED'
  | 'PRIZE_ALREADY_ARCHIVED'
  | 'PRIZE_REVISION_CONFLICT'
  | 'PRIZE_REORDER_CONFLICT'
  | 'PRIZE_EVENT_NOT_EDITABLE'
  | 'PRIZE_INVALID_IMAGE_URL'
  | 'PRIZE_ORDER_INVALID'
  | 'FORM_DRAFT_NOT_FOUND'
  | 'FORM_NOT_EDITABLE'
  | 'FORM_REVISION_CONFLICT'
  | 'FORM_STEP_NOT_FOUND'
  | 'FORM_STEP_NOT_EMPTY'
  | 'FORM_QUESTION_NOT_FOUND'
  | 'FORM_QUESTION_PROTECTED'
  | 'FORM_QUESTION_INVALID'
  | 'FORM_OPTION_NOT_FOUND'
  | 'FORM_OPTION_NOT_ALLOWED'
  | 'FORM_KEY_EXISTS'
  | 'FORM_SYSTEM_FIELD_EXISTS'
  | 'FORM_LIMIT_REACHED'
  | 'FORM_ORDER_INVALID'
  | 'FORM_VERSION_NOT_FOUND'
  | 'FORM_VERSION_INVALID'
  | 'FORM_VERSION_IMMUTABLE'
  | 'FORM_DRAFT_NOT_PUBLISHABLE'
  | 'FORM_REQUIRED_SYSTEM_FIELD_MISSING'
  | 'FORM_REQUIRED_SYSTEM_FIELD_NOT_REQUIRED'
  | 'FORM_SYSTEM_FIELD_TYPE_INVALID'
  | 'FORM_EMPTY_STEP'
  | 'FORM_SELECT_OPTIONS_REQUIRED'
  | 'FORM_NO_UNPUBLISHED_CHANGES'
  | 'FORM_DRAFT_REVISION_CONFLICT'
  | 'FORM_VERSION_NUMBER_CONFLICT'
  | 'FORM_PUBLISH_FAILED'
  | 'PUBLISHED_FORM_REQUIRED'
  // Participants and entries (phase 7)
  | 'PARTICIPANT_NOT_FOUND'
  | 'PARTICIPANT_ALREADY_ENTERED'
  | 'PARTICIPANT_IDENTITY_CONFLICT'
  | 'EVENT_ENTRY_NOT_FOUND'
  | 'EVENT_NOT_ACCEPTING_ENTRIES'
  | 'FORM_VERSION_REQUIRED'
  | 'FORM_ANSWER_UNKNOWN_QUESTION'
  | 'FORM_ANSWER_NOT_ALLOWED'
  | 'FORM_ANSWER_INVALID'
  | 'FORM_REQUIRED_ANSWER_MISSING'
  | 'DUPLICATE_FORM_ANSWER'
  | 'ENTRY_CREATE_FAILED'
  // Eligibility (phase 8)
  | 'DATE_OF_BIRTH_REQUIRED'
  | 'DATE_OF_BIRTH_INVALID'
  | 'EVENT_REGISTRATION_CONFIG_CHANGED';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string>;
    /**
     * Correlates the failure with the server's audit row and log line. Added
     * in phase 2; optional so existing consumers keep working unchanged.
     */
    requestId?: string;
  };
}
