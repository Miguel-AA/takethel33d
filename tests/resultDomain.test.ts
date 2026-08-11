// @vitest-environment node
//
// The rules of publishing and archiving, with no database in sight.
//
// The most important function here is the one that decides how much of a
// winner's name the world sees. It runs exactly once per winner, at publication,
// and what it returns is written into a permanent record — so every case it can
// meet is enumerated rather than assumed.

import { describe, expect, it } from 'vitest';
import {
  EVENT_STATUS_ALLOWING_PUBLICATION,
  PUBLIC_WINNER_IDENTITY_POLICY,
  RESULTS_PUBLICATION_STATES,
  RESULT_FAILURE_CODES,
  archivingWouldDiscardResults,
  canArchiveEvent,
  canPublishResults,
  eventIsArchived,
  formatPublicWinnerName,
  publicationState,
  resultsArePublished,
} from '../shared/resultLifecycle';
import { ACTION_SOURCES, EVENT_STATUSES } from '../shared/eventLifecycle';

// ---------------------------------------------------------------------------
describe('the public form of a winner’s name', () => {
  it('is the first name and the last initial', () => {
    expect(PUBLIC_WINNER_IDENTITY_POLICY).toBe('FIRST_NAME_AND_LAST_INITIAL');
    expect(formatPublicWinnerName({ firstName: 'Miguel', lastName: 'Fuenmayor' })).toBe(
      'Miguel F.',
    );
  });

  it('abbreviates a multi-word surname to ONE letter', () => {
    // "Maria D." and not "Maria D. B.": the point is a single initial, not a
    // shorter version of the whole surname.
    expect(formatPublicWinnerName({ firstName: 'Maria', lastName: 'Del Barrio' })).toBe(
      'Maria D.',
    );
  });

  it('keeps a compound FIRST name whole', () => {
    // The policy abbreviates the surname. A first name is what somebody is
    // called, and truncating it would make the result unrecognisable to them.
    expect(formatPublicWinnerName({ firstName: 'Jean-Luc', lastName: 'Picard' })).toBe(
      'Jean-Luc P.',
    );
    expect(formatPublicWinnerName({ firstName: 'Ana Maria', lastName: 'Lopez' })).toBe(
      'Ana Maria L.',
    );
  });

  it('handles a hyphenated surname', () => {
    expect(formatPublicWinnerName({ firstName: 'Ada', lastName: 'Lovelace-Byron' })).toBe(
      'Ada L.',
    );
  });

  it('handles a single-character surname', () => {
    expect(formatPublicWinnerName({ firstName: 'A', lastName: 'B' })).toBe('A B.');
  });

  it('preserves accents rather than stripping them', () => {
    // "Jose N." would be a different name. The initial is the character as
    // written.
    expect(formatPublicWinnerName({ firstName: 'José', lastName: 'Núñez' })).toBe('José N.');
    expect(formatPublicWinnerName({ firstName: 'Ana', lastName: 'Ñato' })).toBe('Ana Ñ.');
  });

  it('takes a whole code point, not half a surrogate pair', () => {
    // A surname beginning with an astral character must not be cut in two,
    // which is what `last[0]` would do.
    const formatted = formatPublicWinnerName({ firstName: 'Li', lastName: '𠮷田' });
    expect(formatted).toBe('Li 𠮷.');
    expect([...(formatted ?? '')].length).toBe('Li X.'.length);
  });

  it('collapses whitespace, including the invisible kinds', () => {
    // A name pasted from a document can carry a non-breaking space or a tab,
    // and two spellings that read identically must not be recorded differently
    // forever.
    expect(formatPublicWinnerName({ firstName: '  Maria  ', lastName: '  Del   Barrio ' })).toBe(
      'Maria D.',
    );
    expect(formatPublicWinnerName({ firstName: 'Ana Maria', lastName: 'Lopez' })).toBe(
      'Ana Maria L.',
    );
    expect(formatPublicWinnerName({ firstName: 'Ana\tMaria', lastName: 'Lopez' })).toBe(
      'Ana Maria L.',
    );
  });

  it('is deterministic', () => {
    const input = { firstName: 'Miguel', lastName: 'Fuenmayor' };
    const once = formatPublicWinnerName(input);
    for (let i = 0; i < 20; i++) expect(formatPublicWinnerName(input)).toBe(once);
  });

  it('INVENTS NOTHING when a name is missing or blank', () => {
    // A publication is permanent, so a placeholder inside one would be
    // permanent too. The caller fails the whole publication closed instead.
    for (const input of [
      { firstName: '', lastName: 'Lopez' },
      { firstName: 'Ana', lastName: '' },
      { firstName: '   ', lastName: 'Lopez' },
      { firstName: 'Ana', lastName: '   ' },
      { firstName: null, lastName: 'Lopez' },
      { firstName: 'Ana', lastName: null },
      { firstName: undefined, lastName: undefined },
    ]) {
      expect(formatPublicWinnerName(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('never returns an email address or a full surname', () => {
    const formatted = formatPublicWinnerName({
      firstName: 'Miguel',
      lastName: 'Fuenmayor',
    });
    expect(formatted).not.toContain('Fuenmayor');
    expect(formatted).not.toContain('@');
  });

  it('allows two different people to look the same', () => {
    // "Maria D." twice is the policy working. Adding anything to tell them
    // apart would undo the abbreviation.
    expect(formatPublicWinnerName({ firstName: 'Maria', lastName: 'Diaz' })).toBe(
      formatPublicWinnerName({ firstName: 'Maria', lastName: 'Del Barrio' }),
    );
  });
});

// ---------------------------------------------------------------------------
describe('when results may be published', () => {
  const base = { eventStatus: 'DRAW_COMPLETED' as const, hasDraw: true, hasPublication: false };

  it('is DRAW_COMPLETED and nothing else', () => {
    expect(EVENT_STATUS_ALLOWING_PUBLICATION).toBe('DRAW_COMPLETED');
    const allowed = EVENT_STATUSES.filter(
      (eventStatus) => canPublishResults({ ...base, eventStatus }).allowed,
    );
    expect(allowed).toEqual(['DRAW_COMPLETED']);
  });

  it('refuses an event that has already published', () => {
    const permission = canPublishResults({ ...base, hasPublication: true });
    expect(permission).toEqual({ allowed: false, blocker: 'ALREADY_PUBLISHED' });
  });

  it('reports ARCHIVED separately from "not drawn"', () => {
    // Different situations for whoever is reading: one is a state the event has
    // not reached, the other is a door that has closed. Collapsing them would
    // tell an operator to wait for something that will never happen.
    expect(canPublishResults({ ...base, eventStatus: 'ARCHIVED' })).toEqual({
      allowed: false,
      blocker: 'EVENT_ARCHIVED',
    });
    expect(canPublishResults({ ...base, eventStatus: 'DRAW_READY' })).toEqual({
      allowed: false,
      blocker: 'EVENT_NOT_DRAWN',
    });
  });

  it('refuses DRAW_COMPLETED with no draw as corruption', () => {
    expect(canPublishResults({ ...base, hasDraw: false })).toEqual({
      allowed: false,
      blocker: 'NO_DRAW',
    });
  });

  it('checks the publication before the state', () => {
    // An already-published archived event reports ALREADY_PUBLISHED, because
    // that is the fact that matters: there is nothing left to do either way.
    expect(
      canPublishResults({ eventStatus: 'ARCHIVED', hasDraw: true, hasPublication: true }),
    ).toEqual({ allowed: false, blocker: 'ALREADY_PUBLISHED' });
  });
});

// ---------------------------------------------------------------------------
describe('publication state', () => {
  it('is derived from the row, not stored', () => {
    expect(RESULTS_PUBLICATION_STATES).toEqual(['UNPUBLISHED', 'PUBLISHED']);
    expect(publicationState(null)).toBe('UNPUBLISHED');
    expect(publicationState({ id: 'p1' })).toBe('PUBLISHED');
    expect(resultsArePublished(null)).toBe(false);
    expect(resultsArePublished(undefined)).toBe(false);
    expect(resultsArePublished({ id: 'p1' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('archiving', () => {
  it('defers to the lifecycle table rather than restating it', () => {
    // Phase 12 gives `archive` a screen, not a second definition. If the
    // sources ever change, this follows.
    for (const eventStatus of EVENT_STATUSES) {
      expect(canArchiveEvent({ eventStatus, archiveSources: ACTION_SOURCES.archive })).toBe(
        ACTION_SOURCES.archive.includes(eventStatus),
      );
    }
  });

  it('permits both legitimate paths from DRAW_COMPLETED', () => {
    expect(
      canArchiveEvent({
        eventStatus: 'DRAW_COMPLETED',
        archiveSources: ACTION_SOURCES.archive,
      }),
    ).toBe(true);
  });

  it('is terminal', () => {
    expect(
      canArchiveEvent({ eventStatus: 'ARCHIVED', archiveSources: ACTION_SOURCES.archive }),
    ).toBe(false);
    expect(eventIsArchived('ARCHIVED')).toBe(true);
    expect(eventIsArchived('DRAW_COMPLETED')).toBe(false);
  });

  it('warns only when archiving would discard an unpublished result', () => {
    // The last moment anybody can choose: archiving is terminal and publishing
    // afterwards is impossible.
    expect(archivingWouldDiscardResults({ hasDraw: true, hasPublication: false })).toBe(true);
    expect(archivingWouldDiscardResults({ hasDraw: true, hasPublication: true })).toBe(false);
    // No draw, nothing to discard.
    expect(archivingWouldDiscardResults({ hasDraw: false, hasPublication: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the vocabulary', () => {
  it('has no duplicate failure codes', () => {
    expect(new Set(RESULT_FAILURE_CODES).size).toBe(RESULT_FAILURE_CODES.length);
  });

  it('names no way to undo either irreversible act', async () => {
    // Stated as a test so that adding one is a visible change rather than a
    // quiet capability.
    const module = await import('../shared/resultLifecycle');
    const names = Object.keys(module).join(' ').toLowerCase();
    for (const forbidden of ['unpublish', 'unarchive', 'withdraw', 'retract', 'reopen']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});
