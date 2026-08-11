// Assembling the public view of an event.
//
// One place that answers "what does a visitor at this slug see?", so the GET
// handler stays HTTP plumbing and the projection rules are testable without a
// request. Everything it returns has passed through `shared/publicEvent.ts`,
// which copies fields by name — nothing is spread out of a domain object.
//
// It reuses the repositories the administrative side uses rather than issuing
// its own SQL, so "which version does this event serve" and "does that version
// belong to it" are answered by the same code in both flows. A second query
// would be a second chance to get the scoping wrong.

import type { Event } from '../../shared/types';
import {
  derivePublicEventStatus,
  publicVisibility,
  toPublicEventDto,
  toPublicFormDto,
  toPublicPrizeDtos,
  type PublicEventDTO,
  type PublicEventStatus,
  type PublicFormDTO,
} from '../../shared/publicEvent';
import { isValidSlug } from '../../shared/slug';
import { EventRepository } from './eventRepository';
import { FormVersionRepository } from './formVersionRepository';
import { PrizeRepository } from './prizeRepository';
import { PublicFormTokenService } from './publicFormToken';
import { logger } from './logger';

export type PublicEventFailure =
  | { code: 'NOT_FOUND' }
  /** Configured to be open, but nothing servable is behind it. */
  | { code: 'UNAVAILABLE'; reason: string };

export type PublicEventResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: PublicEventFailure };

export class PublicEventService {
  private readonly events: EventRepository;
  private readonly versions: FormVersionRepository;
  private readonly prizes: PrizeRepository;

  constructor(
    db: D1Database,
    private readonly tokens: PublicFormTokenService,
    deps?: {
      events?: EventRepository;
      versions?: FormVersionRepository;
      prizes?: PrizeRepository;
    },
  ) {
    this.events = deps?.events ?? new EventRepository(db);
    this.versions = deps?.versions ?? new FormVersionRepository(db);
    this.prizes = deps?.prizes ?? new PrizeRepository(db);
  }

  /**
   * Resolves a slug to an event that has a public page at all.
   *
   * Two refusals collapse into one answer on purpose: a slug nobody has used
   * and a slug belonging to a DRAFT both produce NOT_FOUND. Distinguishing them
   * would let anyone enumerate the names an organiser is preparing before they
   * chose to announce anything — and "that slug is taken" is exactly the signal
   * a competitor or squatter would want.
   *
   * The slug is validated for SHAPE first. It reaches SQL only through a bound
   * parameter, so this is not an injection defence; it is a cheap refusal that
   * keeps obviously-malformed input from becoming a database round trip.
   */
  async findVisibleEvent(slug: string): Promise<PublicEventResult<Event>> {
    if (!isValidSlug(slug)) return { ok: false, failure: { code: 'NOT_FOUND' } };

    const event = await this.events.findBySlug(slug);
    if (!event) return { ok: false, failure: { code: 'NOT_FOUND' } };
    if (publicVisibility(event.status) === 'hidden') {
      return { ok: false, failure: { code: 'NOT_FOUND' } };
    }

    return { ok: true, value: event };
  }

  /**
   * Builds the whole public projection, at ONE instant.
   *
   * `nowMs` is supplied by the handler and threaded through the status
   * derivation and the token's `issuedAt`, so the page cannot claim OPEN from
   * one moment while carrying a token minted at another.
   */
  async describe(event: Event, nowMs: number): Promise<PublicEventResult<PublicEventDTO>> {
    const nowIso = new Date(nowMs).toISOString();

    // Whether a form can actually be served is a question only the repository
    // can answer: the pointer may be set and still name a version belonging to
    // another event, or one whose questions have been destroyed.
    const pointer = await this.versions.pointerCondition(event.id);
    if (pointer === 'foreign' || pointer === 'missing') {
      logger.error('event points at a form version that is not its own', {
        action: 'EVENT_PUBLISHED_FORM_POINTER_INVALID',
        eventId: event.id,
        reason: pointer,
      });
    }

    const status = derivePublicEventStatus(
      {
        status: event.status,
        registrationOpensAt: event.registrationOpensAt,
        registrationClosesAt: event.registrationClosesAt,
        hasServableForm: pointer === 'valid',
      },
      nowIso,
    );

    // Prizes are shown whatever the status: somebody arriving at an event that
    // has not opened yet, or one that just closed, is entitled to see what was
    // on offer. An event with no prizes is perfectly legitimate and is not a
    // reason to withhold the page.
    const prizes = toPublicPrizeDtos(await this.prizes.listActiveByEvent(event.id));

    // The form and its token exist ONLY while the event is genuinely open.
    // Emitting a token for a closed event would hand out a two-hour licence to
    // submit into something that is not accepting anything.
    if (status !== 'OPEN') {
      return {
        ok: true,
        value: toPublicEventDto({
          event,
          registrationStatus: status,
          form: null,
          prizes,
          formToken: null,
        }),
      };
    }

    const built = await this.buildOpenForm(event, nowMs);
    if (!built.ok) return built;

    return {
      ok: true,
      value: toPublicEventDto({
        event,
        registrationStatus: status,
        form: built.value.form,
        prizes,
        formToken: built.value.token,
      }),
    };
  }

  /**
   * Loads the served version and mints the token that binds it.
   *
   * `findCurrentPublished` is the ONLY place the current pointer is consulted
   * in the whole public flow. From here on the version travels inside the
   * token, and the submission path resolves it by id — never by asking the
   * event again.
   */
  private async buildOpenForm(
    event: Event,
    nowMs: number,
  ): Promise<PublicEventResult<{ form: PublicFormDTO; token: string }>> {
    // Fail closed, and fail EARLY: without a secret there is no way to bind a
    // submission to a version, so serving the form would invite entries that
    // the POST could never safely accept.
    if (!this.tokens.available) {
      logger.error('public form token secret is not configured', {
        action: 'PUBLIC_FORM_TOKEN_SECRET_MISSING',
        eventId: event.id,
      });
      return { ok: false, failure: { code: 'UNAVAILABLE', reason: 'secret_missing' } };
    }

    const record = await this.versions.findCurrentPublished(event.id);
    if (!record) {
      return { ok: false, failure: { code: 'UNAVAILABLE', reason: 'no_published_version' } };
    }

    const loaded = await this.versions.loadVersion(event.id, record.id);
    if (!loaded) {
      return { ok: false, failure: { code: 'UNAVAILABLE', reason: 'version_unreadable' } };
    }

    const projection = toPublicFormDto(loaded.version.versionNumber, loaded.version.steps);
    if (!projection.ok) {
      // A published version is immutable, so a step with nothing askable left in
      // it means something wrote outside the application. Reported loudly rather
      // than rendered as a shorter form: the participant would be filling in
      // something that is not what was published.
      logger.error('published version cannot be projected for the public', {
        action: 'PUBLIC_FORM_PROJECTION_FAILED',
        eventId: event.id,
        versionId: loaded.version.id,
        reason: projection.problem,
      });
      return { ok: false, failure: { code: 'UNAVAILABLE', reason: projection.problem } };
    }

    const token = await this.tokens.issue(event.id, loaded.version.id, nowMs);
    if (token === null) {
      return { ok: false, failure: { code: 'UNAVAILABLE', reason: 'secret_missing' } };
    }

    return { ok: true, value: { form: projection.form, token } };
  }

  /**
   * The copy shown once a submission resolves.
   *
   * Read from the event at RESPONSE time, including on an idempotent replay.
   * That is a deliberate contract: the identity of the outcome — eligible or
   * not, and why — is frozen on the entry and never recomputed, while the words
   * around it are editorial and follow the event. An operator fixing a typo in
   * a confirmation message should fix it for everybody, including somebody who
   * refreshes a result page, and phase 3 already treats these four fields as
   * editable long after entries exist.
   *
   * Null values are not filled in here. The server does not know the visitor's
   * language; the client falls back to its own i18n strings.
   */
  static messageFor(
    event: Event,
    eligible: boolean,
  ): { title: string | null; body: string | null } {
    return eligible
      ? { title: event.confirmationTitle, body: event.confirmationMessage }
      : { title: event.ineligibleTitle, body: event.ineligibleMessage };
  }

  /** Exposed so the POST handler can report a status without rebuilding the DTO. */
  async publicStatusOf(event: Event, nowMs: number): Promise<PublicEventStatus> {
    const pointer = await this.versions.pointerCondition(event.id);
    return derivePublicEventStatus(
      {
        status: event.status,
        registrationOpensAt: event.registrationOpensAt,
        registrationClosesAt: event.registrationClosesAt,
        hasServableForm: pointer === 'valid',
      },
      new Date(nowMs).toISOString(),
    );
  }
}
