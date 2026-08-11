// @vitest-environment jsdom
//
// The routing contract between the phase 9 participant flow and everything
// that was already there.
//
// This suite exists because a mutation survived without it: replacing the
// legacy `/events` route with the new public page broke nothing that any test
// could see. `/events` is the lead-capture page the business has been running
// since before any of this existed, and "we did not touch it" is a claim that
// needs an assertion behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';

// The public page fetches through the API client; the legacy page does not need
// the network to render its first step. Stubbing keeps this suite about routing.
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      getPublicEvent: vi.fn().mockResolvedValue({
        event: {
          slug: 'summer-giveaway',
          name: 'Summer Giveaway Public Page',
          description: null,
          bannerUrl: null,
          locationName: null,
          timezone: 'UTC',
          registrationOpensAt: null,
          registrationClosesAt: null,
          startsAt: null,
          endsAt: null,
          minimumAge: null,
          registrationStatus: 'CLOSED',
          messages: {
            confirmationTitle: null,
            confirmationMessage: null,
            ineligibleTitle: null,
            ineligibleMessage: null,
          },
          form: null,
          prizes: [],
          formToken: null,
        },
      }),
    },
  };
});

function visit(path: string) {
  window.history.pushState({}, '', path);
  render(<App />);
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the legacy lead-capture flow is untouched', () => {
  it('/events still renders the legacy registration page', async () => {
    // NOT the phase 9 public page. This route predates the event domain
    // entirely and belongs to a different feature that happens to live behind a
    // similar-sounding word.
    visit('/events');

    await waitFor(() => {
      expect(screen.queryByText('Summer Giveaway Public Page')).toBeNull();
    });

    // The legacy page is a form; the public page for a closed event is not.
    const hasForm =
      document.querySelector('form') !== null ||
      document.querySelectorAll('input, select, textarea').length > 0;
    expect(hasForm).toBe(true);
  });

  it('/events is an exact route, so it cannot be captured by a dynamic sibling', () => {
    visit('/events');
    expect(screen.queryByText('Summer Giveaway Public Page')).toBeNull();
  });
});

describe('the participant flow lives on its own prefix', () => {
  it('/e/:slug renders the public event page', async () => {
    visit('/e/summer-giveaway');
    expect(await screen.findByText('Summer Giveaway Public Page')).toBeTruthy();
  });

  it('shows no administrative chrome to a visitor', async () => {
    // Somebody arriving from a printed flyer is not an operator: offering them
    // a manager link is confusing and an invitation to probe.
    visit('/e/summer-giveaway');
    await screen.findByText('Summer Giveaway Public Page');

    expect(screen.queryByRole('link', { name: /manager/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /log ?out|cerrar sesión/i })).toBeNull();
  });

  it('does not require a session — no redirect to the login page', async () => {
    visit('/e/summer-giveaway');
    await screen.findByText('Summer Giveaway Public Page');
    expect(window.location.pathname).toBe('/e/summer-giveaway');
  });

  it('an unknown slug stays on the public route rather than bouncing home', async () => {
    visit('/e/anything-at-all');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/e/anything-at-all');
    });
  });
});

describe('the two do not collide', () => {
  it('the marketing home is still the home', () => {
    visit('/');
    expect(window.location.pathname).toBe('/');
  });

  it('/manager/login is untouched by the public prefix', () => {
    visit('/manager/login');
    expect(window.location.pathname).toBe('/manager/login');
  });
});
