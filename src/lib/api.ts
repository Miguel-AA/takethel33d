import type {
  AdminLoginResponse,
  AdminLogoutResponse,
  AdminMeResponse,
  ApiErrorBody,
  ApiErrorCode,
  Attendee,
  AttendeeListResponse,
  AuditListResponse,
  AuditLog,
  CreateEventInput,
  CurrentRaffleResponse,
  DuplicateEventInput,
  Event,
  EventDetailResponse,
  EventListResponse,
  EventTransitionAction,
  EventTransitionResponse,
  UpdateEventInput,
  CreateEventPrizeInput,
  EventPrize,
  EventPrizeDetailResponse,
  EventPrizeListResponse,
  PrizeMutationResponse,
  PrizeTransitionAction,
  ReorderEventPrizeItem,
  UpdateEventPrizeInput,
  CreateFormOptionInput,
  CreateFormQuestionInput,
  CreateFormStepInput,
  EventFormDraftResponse,
  FormDraftMutationResponse,
  FormPreviewResponse,
  ReorderFormItem,
  UpdateFormOptionInput,
  UpdateFormQuestionInput,
  UpdateFormStepInput,
  EventFormVersionDetailResponse,
  EventFormVersionListResponse,
  FormPublishValidationResponse,
  PublishFormResponse,
  PublishedFormResponse,
  CreateEventEntryResponse,
  EventEntryDetail,
  EventEntryListResponse,
  SubmittedAnswer,
  Metrics,
  RaffleDrawRequest,
  RaffleDrawResponse,
  RegisterRequest,
  RegisterResponse,
  PublicEventResponse,
  PublicEntryResponse,
  PublicSubmissionInput,
  AdminParticipantListResponse,
  AdminParticipantSummaryResponse,
  AdminParticipantDetailResponse,
  ParticipantMutationResponse,
  DisqualifyEntryInput,
  ReinstateEntryInput,
  DrawResponse,
  DrawStatusResponse,
  AdminEventResults,
  PublishResultsResponse,
  PublicEventResultsDTO,
  ParticipantEligibilityFilter,
  ParticipantStatusFilter,
} from '@shared/types';

/** Filters accepted by the administrative participants listing. All optional. */
export interface AdminParticipantQueryParams {
  page?: number;
  pageSize?: number;
  search?: string;
  eligibility?: ParticipantEligibilityFilter;
  status?: ParticipantStatusFilter;
  formVersionId?: string;
}

/** Filters accepted by the prize listing. All optional. */
export interface PrizeQueryParams {
  page?: number;
  pageSize?: number;
  status?: string;
  archived?: 'active' | 'archived' | 'all';
  search?: string;
  sort?: 'sortOrder' | 'name' | 'quantity' | 'createdAt' | 'updatedAt';
  direction?: 'asc' | 'desc';
}

/** Filters accepted by the event listing. All optional. */
export interface EventQueryParams {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  archived?: 'active' | 'archived' | 'all';
  sort?: 'createdAt' | 'updatedAt' | 'name' | 'startsAt';
  direction?: 'asc' | 'desc';
}

/** Filters accepted by the entry listing. All optional. */
export interface EntryQueryParams {
  page?: number;
  pageSize?: number;
  /** Matches a name or an email. There are no answer filters in this phase. */
  search?: string;
}

/** Filters accepted by the audit listing. All optional. */
export interface AuditQueryParams {
  page?: number;
  pageSize?: number;
  actorAdminId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  eventId?: string;
  from?: string;
  to?: string;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const USE_MOCK =
  import.meta.env.VITE_USE_MOCK_API === 'true' ||
  (import.meta.env.DEV &&
    import.meta.env.VITE_USE_MOCK_API !== 'false' &&
    !BASE_URL);

/**
 * Loads the in-memory mock on demand.
 *
 * The import is dynamic and guarded by `USE_MOCK`, which the bundler folds to a
 * constant. In a production build the branch is dead, so the mock (including
 * its demo administrator fixtures and their fake passwords) is eliminated from
 * the output instead of shipping to real users.
 */
async function mock() {
  const module = await import('./mockApi');
  return module.mockApi;
}

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  fields?: Record<string, string>;
  /** Server correlation id, when the response carried one. */
  requestId?: string;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields?: Record<string, string>,
    requestId?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
  }
}

/** 401 codes that all mean "this session can no longer be used". */
const SESSION_ENDED_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'UNAUTHORIZED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'ADMIN_SUSPENDED',
  'ADMIN_DISABLED',
]);

export function isSessionEnded(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    SESSION_ENDED_CODES.has(error.code)
  );
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    // The session travels in an HttpOnly cookie the client cannot read, so it
    // must be attached by the browser. The SPA and the API are same-origin.
    credentials: 'same-origin',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let errorBody: ApiErrorBody | null = null;
    try {
      errorBody = (await res.json()) as ApiErrorBody;
    } catch {
      // fallthrough
    }
    const code: ApiErrorCode =
      errorBody?.error?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : 'SERVER_ERROR');
    const message = errorBody?.error?.message ?? res.statusText;
    // Prefer the body's id, fall back to the header the middleware always sets.
    const requestId =
      errorBody?.error?.requestId ?? res.headers?.get?.('X-Request-ID') ?? undefined;
    throw new ApiError(res.status, code, message, errorBody?.error?.fields, requestId);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // -------------------------------------------------------------------------
  // Public flow (phase 9)
  //
  // Ordinary methods on the same client rather than a second one. The property
  // that matters — a public response must not change because the browser holds
  // an administrator's cookie — is enforced on the SERVER, where
  // `/api/public-events/*` is outside `PROTECTED_ROUTES` and no handler reads
  // `ctx.data.admin`. A separate client would duplicate error handling and the
  // mock switch without adding that guarantee.
  //
  // `credentials: 'same-origin'` therefore still applies and is harmless: the
  // cookie is sent and ignored.
  // -------------------------------------------------------------------------

  /** The public event page. Never send an admin header; there is none to send. */
  getPublicEvent(slug: string): Promise<PublicEventResponse> {
    if (USE_MOCK) return mock().then((m) => m.getPublicEvent(slug));
    return request<PublicEventResponse>(
      'GET',
      `/api/public-events/${encodeURIComponent(slug)}`,
    );
  },

  submitPublicEntry(
    slug: string,
    body: PublicSubmissionInput,
  ): Promise<PublicEntryResponse> {
    if (USE_MOCK) return mock().then((m) => m.submitPublicEntry(slug, body));
    return request<PublicEntryResponse>(
      'POST',
      `/api/public-events/${encodeURIComponent(slug)}/entries`,
      { body },
    );
  },

  // -------------------------------------------------------------------------
  // Participant administration (phase 10)
  // -------------------------------------------------------------------------

  listAdminParticipants(
    eventId: string,
    params: AdminParticipantQueryParams = {},
  ): Promise<AdminParticipantListResponse> {
    if (USE_MOCK) return mock().then((m) => m.listAdminParticipants(eventId, params));
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    if (params.search) q.set('q', params.search);
    if (params.eligibility && params.eligibility !== 'ALL') {
      q.set('eligibility', params.eligibility);
    }
    if (params.status && params.status !== 'ALL') q.set('status', params.status);
    if (params.formVersionId) q.set('formVersionId', params.formVersionId);
    const qs = q.toString();
    return request<AdminParticipantListResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/participants${qs ? `?${qs}` : ''}`,
    );
  },

  getAdminParticipantSummary(eventId: string): Promise<AdminParticipantSummaryResponse> {
    if (USE_MOCK) return mock().then((m) => m.getAdminParticipantSummary(eventId));
    return request<AdminParticipantSummaryResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/participants/summary`,
    );
  },

  getAdminParticipant(
    eventId: string,
    entryId: string,
  ): Promise<AdminParticipantDetailResponse> {
    if (USE_MOCK) return mock().then((m) => m.getAdminParticipant(eventId, entryId));
    return request<AdminParticipantDetailResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/participants/${encodeURIComponent(entryId)}`,
    );
  },

  disqualifyParticipant(
    eventId: string,
    entryId: string,
    body: DisqualifyEntryInput,
  ): Promise<ParticipantMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.disqualifyParticipant(eventId, entryId, body));
    return request<ParticipantMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/participants/${encodeURIComponent(entryId)}/disqualify`,
      { body },
    );
  },

  reinstateParticipant(
    eventId: string,
    entryId: string,
    body: ReinstateEntryInput,
  ): Promise<ParticipantMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.reinstateParticipant(eventId, entryId, body));
    return request<ParticipantMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/participants/${encodeURIComponent(entryId)}/reinstate`,
      { body },
    );
  },

  // -------------------------------------------------------------------------
  // The draw (phase 11)
  // -------------------------------------------------------------------------

  getDraw(eventId: string): Promise<DrawStatusResponse> {
    if (USE_MOCK) return mock().then((m) => m.getDraw(eventId));
    return request<DrawStatusResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/draw`,
    );
  },

  /**
   * Runs the draw.
   *
   * NO BODY, and that is the contract rather than an omission. The candidates,
   * the prizes, the winners and the moment are all resolved server-side; there
   * is nothing here for a caller to influence, and `runDrawSchema` refuses
   * anything that tries.
   */
  runDraw(eventId: string): Promise<DrawResponse> {
    if (USE_MOCK) return mock().then((m) => m.runDraw(eventId));
    return request<DrawResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/draw`,
      { body: {} },
    );
  },

  // -------------------------------------------------------------------------
  // Results, publication and archiving (phase 12)
  // -------------------------------------------------------------------------

  getEventResults(eventId: string): Promise<AdminEventResults> {
    if (USE_MOCK) return mock().then((m) => m.getEventResults(eventId));
    return request<AdminEventResults>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/results`,
    );
  },

  /**
   * Publishes the results.
   *
   * NO BODY, and that is the contract rather than an omission. The winners come
   * from the draw, their public names from `formatPublicWinnerName`, the prize
   * names from the snapshots taken when they were won. `publishResultsSchema`
   * refuses anything that tries to say otherwise.
   */
  publishResults(eventId: string): Promise<PublishResultsResponse> {
    if (USE_MOCK) return mock().then((m) => m.publishResults(eventId));
    return request<PublishResultsResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/results/publish`,
      { body: {} },
    );
  },

  /** The published winners. Unauthenticated, and addressed by SLUG. */
  getPublicEventResults(slug: string): Promise<PublicEventResultsDTO> {
    if (USE_MOCK) return mock().then((m) => m.getPublicEventResults(slug));
    return request<PublicEventResultsDTO>(
      'GET',
      `/api/public-events/${encodeURIComponent(slug)}/results`,
    );
  },

  register(body: RegisterRequest): Promise<RegisterResponse> {
    if (USE_MOCK) return mock().then((m) => m.register(body));
    return request<RegisterResponse>('POST', '/api/register', { body });
  },

  login(email: string, password: string): Promise<AdminLoginResponse> {
    if (USE_MOCK) return mock().then((m) => m.login(email, password));
    return request<AdminLoginResponse>('POST', '/api/manager/login', {
      body: { email, password },
    });
  },

  me(): Promise<AdminMeResponse> {
    if (USE_MOCK) return mock().then((m) => m.me());
    return request<AdminMeResponse>('GET', '/api/manager/me');
  },

  logout(): Promise<AdminLogoutResponse> {
    if (USE_MOCK) return mock().then((m) => m.logout());
    return request<AdminLogoutResponse>('POST', '/api/manager/logout');
  },

  listAttendees(params: {
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AttendeeListResponse> {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    if (USE_MOCK) return mock().then((m) => m.listAttendees(params));
    return request<AttendeeListResponse>(
      'GET',
      `/api/attendees${qs ? `?${qs}` : ''}`,
    );
  },

  getAttendee(id: string): Promise<Attendee> {
    if (USE_MOCK) return mock().then((m) => m.getAttendee(id));
    return request<Attendee>('GET', `/api/attendees/${encodeURIComponent(id)}`);
  },

  metrics(): Promise<Metrics> {
    if (USE_MOCK) return mock().then((m) => m.metrics());
    return request<Metrics>('GET', '/api/metrics');
  },

  drawRaffle(body: RaffleDrawRequest): Promise<RaffleDrawResponse> {
    if (USE_MOCK) return mock().then((m) => m.drawRaffle(body));
    return request<RaffleDrawResponse>('POST', '/api/raffle/draw', { body });
  },

  currentRaffle(): Promise<CurrentRaffleResponse | null> {
    if (USE_MOCK) return mock().then((m) => m.currentRaffle());
    return request<CurrentRaffleResponse | null>('GET', '/api/raffle/current');
  },

  listAuditLogs(params: AuditQueryParams = {}): Promise<AuditListResponse> {
    if (USE_MOCK) return mock().then((m) => m.listAuditLogs(params));
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        q.set(key, String(value));
      }
    }
    const qs = q.toString();
    return request<AuditListResponse>('GET', `/api/audit${qs ? `?${qs}` : ''}`);
  },

  getAuditLog(id: string): Promise<AuditLog> {
    if (USE_MOCK) return mock().then((m) => m.getAuditLog(id));
    return request<AuditLog>('GET', `/api/audit/${encodeURIComponent(id)}`);
  },

  // --- Events -------------------------------------------------------------

  listEvents(params: EventQueryParams = {}): Promise<EventListResponse> {
    if (USE_MOCK) return mock().then((m) => m.listEvents(params));
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
    }
    const qs = q.toString();
    return request<EventListResponse>('GET', `/api/events${qs ? `?${qs}` : ''}`);
  },

  getEvent(id: string): Promise<EventDetailResponse> {
    if (USE_MOCK) return mock().then((m) => m.getEvent(id));
    return request<EventDetailResponse>('GET', `/api/events/${encodeURIComponent(id)}`);
  },

  createEvent(body: CreateEventInput): Promise<Event> {
    if (USE_MOCK) return mock().then((m) => m.createEvent(body));
    return request<Event>('POST', '/api/events', { body });
  },

  updateEvent(id: string, body: UpdateEventInput): Promise<Event> {
    if (USE_MOCK) return mock().then((m) => m.updateEvent(id, body));
    return request<Event>('PATCH', `/api/events/${encodeURIComponent(id)}`, { body });
  },

  deleteEvent(id: string, expectedRevision?: number): Promise<{ ok: true; id: string }> {
    if (USE_MOCK) return mock().then((m) => m.deleteEvent(id, expectedRevision));
    const qs = expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`;
    return request<{ ok: true; id: string }>(
      'DELETE',
      `/api/events/${encodeURIComponent(id)}${qs}`,
    );
  },

  duplicateEvent(id: string, body: DuplicateEventInput = {}): Promise<Event> {
    if (USE_MOCK) return mock().then((m) => m.duplicateEvent(id, body));
    return request<Event>('POST', `/api/events/${encodeURIComponent(id)}/duplicate`, {
      body,
    });
  },

  transitionEvent(
    id: string,
    action: EventTransitionAction,
    expectedRevision?: number,
  ): Promise<EventTransitionResponse> {
    if (USE_MOCK) return mock().then((m) => m.transitionEvent(id, action, expectedRevision));
    return request<EventTransitionResponse>(
      'POST',
      `/api/events/${encodeURIComponent(id)}/${action}`,
      { body: expectedRevision === undefined ? {} : { expectedRevision } },
    );
  },

  // --- Event prizes -------------------------------------------------------

  listEventPrizes(
    eventId: string,
    params: PrizeQueryParams = {},
  ): Promise<EventPrizeListResponse> {
    if (USE_MOCK) return mock().then((m) => m.listEventPrizes(eventId, params));
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
    }
    const qs = q.toString();
    return request<EventPrizeListResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/prizes${qs ? `?${qs}` : ''}`,
    );
  },

  getEventPrize(eventId: string, prizeId: string): Promise<EventPrizeDetailResponse> {
    if (USE_MOCK) return mock().then((m) => m.getEventPrize(eventId, prizeId));
    return request<EventPrizeDetailResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/prizes/${encodeURIComponent(prizeId)}`,
    );
  },

  createEventPrize(eventId: string, body: CreateEventPrizeInput): Promise<EventPrize> {
    if (USE_MOCK) return mock().then((m) => m.createEventPrize(eventId, body));
    return request<EventPrize>('POST', `/api/events/${encodeURIComponent(eventId)}/prizes`, {
      body,
    });
  },

  updateEventPrize(
    eventId: string,
    prizeId: string,
    body: UpdateEventPrizeInput,
  ): Promise<EventPrize> {
    if (USE_MOCK) return mock().then((m) => m.updateEventPrize(eventId, prizeId, body));
    return request<EventPrize>(
      'PATCH',
      `/api/events/${encodeURIComponent(eventId)}/prizes/${encodeURIComponent(prizeId)}`,
      { body },
    );
  },

  deleteEventPrize(
    eventId: string,
    prizeId: string,
    expectedRevision?: number,
  ): Promise<{ ok: true; id: string }> {
    if (USE_MOCK)
      return mock().then((m) => m.deleteEventPrize(eventId, prizeId, expectedRevision));
    const qs = expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`;
    return request<{ ok: true; id: string }>(
      'DELETE',
      `/api/events/${encodeURIComponent(eventId)}/prizes/${encodeURIComponent(prizeId)}${qs}`,
    );
  },

  transitionEventPrize(
    eventId: string,
    prizeId: string,
    action: PrizeTransitionAction,
    expectedRevision?: number,
  ): Promise<PrizeMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) =>
        m.transitionEventPrize(eventId, prizeId, action, expectedRevision),
      );
    return request<PrizeMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/prizes/${encodeURIComponent(prizeId)}/${action}`,
      { body: expectedRevision === undefined ? {} : { expectedRevision } },
    );
  },

  reorderEventPrizes(
    eventId: string,
    items: ReorderEventPrizeItem[],
  ): Promise<{ items: EventPrize[] }> {
    if (USE_MOCK) return mock().then((m) => m.reorderEventPrizes(eventId, items));
    return request<{ items: EventPrize[] }>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/prizes/reorder`,
      { body: { items } },
    );
  },

  // --- Form builder -------------------------------------------------------
  //
  // Every mutation answers with the WHOLE draft. The builder therefore never
  // merges a partial response into what it holds: it replaces, which is what
  // keeps a three-panel editor from drifting out of step with the server.

  getFormDraft(eventId: string): Promise<EventFormDraftResponse> {
    if (USE_MOCK) return mock().then((m) => m.getFormDraft(eventId));
    return request<EventFormDraftResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/form`,
    );
  },

  /** Creates the form. Idempotent, so clicking twice is harmless. */
  createFormDraft(eventId: string): Promise<EventFormDraftResponse> {
    if (USE_MOCK) return mock().then((m) => m.createFormDraft(eventId));
    return request<EventFormDraftResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form`,
      { body: {} },
    );
  },

  saveFormDraft(eventId: string, expectedRevision: number): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.saveFormDraft(eventId, expectedRevision));
    return request<FormDraftMutationResponse>(
      'PUT',
      `/api/events/${encodeURIComponent(eventId)}/form`,
      { body: { expectedRevision } },
    );
  },

  previewFormDraft(eventId: string): Promise<FormPreviewResponse> {
    if (USE_MOCK) return mock().then((m) => m.previewFormDraft(eventId));
    return request<FormPreviewResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/preview`,
      { body: {} },
    );
  },

  createFormStep(
    eventId: string,
    body: CreateFormStepInput,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.createFormStep(eventId, body));
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/steps`,
      { body },
    );
  },

  updateFormStep(
    eventId: string,
    stepId: string,
    body: UpdateFormStepInput,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.updateFormStep(eventId, stepId, body));
    return request<FormDraftMutationResponse>(
      'PATCH',
      `/api/events/${encodeURIComponent(eventId)}/form/steps/${encodeURIComponent(stepId)}`,
      { body },
    );
  },

  deleteFormStep(
    eventId: string,
    stepId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.deleteFormStep(eventId, stepId, expectedRevision));
    return request<FormDraftMutationResponse>(
      'DELETE',
      `/api/events/${encodeURIComponent(eventId)}/form/steps/${encodeURIComponent(stepId)}`,
      { body: { expectedRevision } },
    );
  },

  reorderFormSteps(
    eventId: string,
    expectedRevision: number,
    items: ReorderFormItem[],
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.reorderFormSteps(eventId, expectedRevision, items));
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/steps/reorder`,
      { body: { expectedRevision, items } },
    );
  },

  createFormQuestion(
    eventId: string,
    body: CreateFormQuestionInput,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.createFormQuestion(eventId, body));
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/questions`,
      { body },
    );
  },

  updateFormQuestion(
    eventId: string,
    questionId: string,
    body: UpdateFormQuestionInput,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.updateFormQuestion(eventId, questionId, body));
    return request<FormDraftMutationResponse>(
      'PATCH',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}`,
      { body },
    );
  },

  deleteFormQuestion(
    eventId: string,
    questionId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) => m.deleteFormQuestion(eventId, questionId, expectedRevision));
    return request<FormDraftMutationResponse>(
      'DELETE',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}`,
      { body: { expectedRevision } },
    );
  },

  duplicateFormQuestion(
    eventId: string,
    questionId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) => m.duplicateFormQuestion(eventId, questionId, expectedRevision));
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}/duplicate`,
      { body: { expectedRevision } },
    );
  },

  reorderFormQuestions(
    eventId: string,
    expectedRevision: number,
    stepId: string,
    items: ReorderFormItem[],
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) => m.reorderFormQuestions(eventId, expectedRevision, stepId, items));
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/reorder`,
      { body: { expectedRevision, stepId, items } },
    );
  },

  createFormOption(
    eventId: string,
    questionId: string,
    body: CreateFormOptionInput,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK) return mock().then((m) => m.createFormOption(eventId, questionId, body));
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}/options`,
      { body },
    );
  },

  updateFormOption(
    eventId: string,
    questionId: string,
    optionId: string,
    body: UpdateFormOptionInput,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) => m.updateFormOption(eventId, questionId, optionId, body));
    return request<FormDraftMutationResponse>(
      'PATCH',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}/options/${encodeURIComponent(optionId)}`,
      { body },
    );
  },

  deleteFormOption(
    eventId: string,
    questionId: string,
    optionId: string,
    expectedRevision: number,
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) =>
        m.deleteFormOption(eventId, questionId, optionId, expectedRevision),
      );
    return request<FormDraftMutationResponse>(
      'DELETE',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}/options/${encodeURIComponent(optionId)}`,
      { body: { expectedRevision } },
    );
  },

  reorderFormOptions(
    eventId: string,
    questionId: string,
    expectedRevision: number,
    items: ReorderFormItem[],
  ): Promise<FormDraftMutationResponse> {
    if (USE_MOCK)
      return mock().then((m) =>
        m.reorderFormOptions(eventId, questionId, expectedRevision, items),
      );
    return request<FormDraftMutationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/questions/${encodeURIComponent(questionId)}/options/reorder`,
      { body: { expectedRevision, items } },
    );
  },

  // --- Publishing ---------------------------------------------------------
  //
  // Publishing sends a REVISION, never a form: the server freezes the draft it
  // already holds, so what gets published cannot differ from what was reviewed.

  validatePublishForm(
    eventId: string,
    expectedDraftRevision?: number,
  ): Promise<FormPublishValidationResponse> {
    if (USE_MOCK)
      return mock().then((m) => m.validatePublishForm(eventId, expectedDraftRevision));
    return request<FormPublishValidationResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/validate-publish`,
      { body: expectedDraftRevision === undefined ? {} : { expectedDraftRevision } },
    );
  },

  publishForm(eventId: string, expectedDraftRevision: number): Promise<PublishFormResponse> {
    if (USE_MOCK) return mock().then((m) => m.publishForm(eventId, expectedDraftRevision));
    return request<PublishFormResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/form/publish`,
      { body: { expectedDraftRevision } },
    );
  },

  listFormVersions(eventId: string): Promise<EventFormVersionListResponse> {
    if (USE_MOCK) return mock().then((m) => m.listFormVersions(eventId));
    return request<EventFormVersionListResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/form/versions`,
    );
  },

  getFormVersion(
    eventId: string,
    versionId: string,
  ): Promise<EventFormVersionDetailResponse> {
    if (USE_MOCK) return mock().then((m) => m.getFormVersion(eventId, versionId));
    return request<EventFormVersionDetailResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/form/versions/${encodeURIComponent(versionId)}`,
    );
  },

  getPublishedForm(eventId: string): Promise<PublishedFormResponse> {
    if (USE_MOCK) return mock().then((m) => m.getPublishedForm(eventId));
    return request<PublishedFormResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/form/published`,
    );
  },

  // --- Participants and entries --------------------------------------------
  //
  // The resource is an ENTRY — a participation, bound to a form version. The
  // server also serves it under `/participants`, which is what the screen is
  // called; the client uses the canonical name so there is one path in one
  // place.

  listEventEntries(
    eventId: string,
    params: EntryQueryParams = {},
  ): Promise<EventEntryListResponse> {
    if (USE_MOCK) return mock().then((m) => m.listEventEntries(eventId, params));
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
    }
    const qs = q.toString();
    return request<EventEntryListResponse>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/entries${qs ? `?${qs}` : ''}`,
    );
  },

  getEventEntry(eventId: string, entryId: string): Promise<EventEntryDetail> {
    if (USE_MOCK) return mock().then((m) => m.getEventEntry(eventId, entryId));
    return request<EventEntryDetail>(
      'GET',
      `/api/events/${encodeURIComponent(eventId)}/entries/${encodeURIComponent(entryId)}`,
    );
  },

  /**
   * Records a participation.
   *
   * The body carries ANSWERS and nothing else. There is no participant object
   * and no version id: the server reads the identity off the answers and binds
   * the entry to the version the event currently serves.
   */
  createEventEntry(
    eventId: string,
    answers: SubmittedAnswer[],
  ): Promise<CreateEventEntryResponse> {
    if (USE_MOCK) return mock().then((m) => m.createEventEntry(eventId, answers));
    return request<CreateEventEntryResponse>(
      'POST',
      `/api/events/${encodeURIComponent(eventId)}/entries`,
      { body: { answers } },
    );
  },
};
