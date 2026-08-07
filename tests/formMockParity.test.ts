// Observable parity between the dev mock and the real backend, for the form.
//
// The mock does not reproduce D1 and is not meant to. What it MUST reproduce is
// every rule the builder can observe: one revision for the whole form, the same
// per-event-state permission, the same protected system fields, the same
// limits, the same refusals, the same preview problems.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_STATUSES, type EventStatus } from '../shared/eventLifecycle';
import { eventAllowsFormEditing } from '../shared/formLifecycle';
import { FORM_STEPS_MAX } from '../shared/limits';
import type { EventFormDraft, FormQuestion } from '../shared/types';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function freshMock(signIn = true) {
  const mod = await import('../src/lib/mockApi');
  if (signIn) await mod.mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  return { mockApi: mod.mockApi, setEventStatus: mod.__setMockEventStatus };
}

let mock: Awaited<ReturnType<typeof freshMock>>;

async function newEvent(name = 'Form Parity Event') {
  return mock.mockApi.createEvent({
    name,
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  });
}

const questionsOf = (draft: EventFormDraft): FormQuestion[] =>
  draft.steps.flatMap((step) => step.questions);

async function eventWithDraft(name = 'Form Parity Event') {
  const event = await newEvent(name);
  const created = await mock.mockApi.createFormDraft(event.id);
  if (!created.draft) throw new Error('draft missing');
  return { event, draft: created.draft };
}

async function eventWithStep(name = 'Form Parity Event') {
  const { event, draft } = await eventWithDraft(name);
  const result = await mock.mockApi.createFormStep(event.id, {
    expectedRevision: draft.revision,
    title: 'About you',
  });
  return { event, draft: result.draft };
}

beforeEach(async () => {
  vi.resetModules();
  mock = await freshMock();
});

/** A draft that satisfies every publication rule, built through the mock. */
async function publishableDraft(name = 'Publishable Event') {
  const { event, draft } = await eventWithDraft(name);
  let form = (
    await mock.mockApi.createFormStep(event.id, {
      expectedRevision: draft.revision,
      title: 'About you',
    })
  ).draft;

  const stepId = form.steps[0].id;
  for (const [field, type] of [
    ['FIRST_NAME', 'SHORT_TEXT'],
    ['LAST_NAME', 'SHORT_TEXT'],
    ['EMAIL', 'EMAIL'],
  ] as const) {
    form = (
      await mock.mockApi.createFormQuestion(event.id, {
        expectedRevision: form.revision,
        stepId,
        type,
        systemField: field,
        label: field,
        required: true,
      })
    ).draft;
  }
  return { event, draft: form };
}

// ---------------------------------------------------------------------------
describe('publishing parity', () => {
  it('refuses a draft that is not ready, naming the same issues', async () => {
    const { event, draft } = await eventWithStep();
    const verdict = await mock.mockApi.validatePublishForm(event.id, draft.revision);
    expect(verdict.publishable).toBe(false);
    expect(verdict.errors.map((issue) => issue.code)).toContain('MISSING_SYSTEM_FIELD');
    expect(verdict.errors.map((issue) => issue.code)).toContain('EMPTY_STEP');

    await expect(mock.mockApi.publishForm(event.id, draft.revision)).rejects.toMatchObject({
      code: 'FORM_DRAFT_NOT_PUBLISHABLE',
    });
  });

  it('freezes version 1 and leaves the draft editable at the same revision', async () => {
    const { event, draft } = await publishableDraft();
    const published = await mock.mockApi.publishForm(event.id, draft.revision);

    expect(published.version.versionNumber).toBe(1);
    expect(published.version.sourceDraftRevision).toBe(draft.revision);
    // Publishing is not an edit: the draft stays exactly where it was.
    expect(published.draft.revision).toBe(draft.revision);

    const after = await mock.mockApi.getFormDraft(event.id);
    expect(after.publishedVersionNumber).toBe(1);
    expect(after.hasUnpublishedChanges).toBe(false);
  });

  it('editing after publishing cannot reach the published version', async () => {
    const { event, draft } = await publishableDraft();
    const published = await mock.mockApi.publishForm(event.id, draft.revision);
    const question = draft.steps[0].questions[0];

    await mock.mockApi.updateFormQuestion(event.id, question.id, {
      expectedRevision: draft.revision,
      label: 'Changed after publishing',
    });

    const frozen = await mock.mockApi.getFormVersion(event.id, published.version.id);
    const labels = frozen.version.steps.flatMap((step) => step.questions.map((q) => q.label));
    expect(labels).not.toContain('Changed after publishing');
  });

  it('refuses to publish twice without a change, then numbers the next one', async () => {
    const { event, draft } = await publishableDraft();
    const first = await mock.mockApi.publishForm(event.id, draft.revision);

    await expect(mock.mockApi.publishForm(event.id, draft.revision)).rejects.toMatchObject({
      code: 'FORM_NO_UNPUBLISHED_CHANGES',
    });

    const moved = await mock.mockApi.saveFormDraft(event.id, first.draft.revision);
    const second = await mock.mockApi.publishForm(event.id, moved.draft.revision);
    expect(second.version.versionNumber).toBe(2);
  });

  it('refuses a revision other than the one confirmed', async () => {
    const { event, draft } = await publishableDraft();
    await expect(
      mock.mockApi.publishForm(event.id, draft.revision - 1),
    ).rejects.toMatchObject({ code: 'FORM_DRAFT_REVISION_CONFLICT' });
  });

  it('requires a date of birth when the event has a minimum age', async () => {
    const { event, draft } = await publishableDraft();
    await mock.mockApi.updateEvent(event.id, { expectedRevision: 1, minimumAge: 21 });

    const verdict = await mock.mockApi.validatePublishForm(event.id, draft.revision);
    expect(verdict.publishable).toBe(false);
    expect(
      verdict.errors.find((issue) => issue.code === 'MISSING_SYSTEM_FIELD')?.subject,
    ).toBe('DATE_OF_BIRTH');
  });

  it('lists history newest first and marks the live one', async () => {
    const { event, draft } = await publishableDraft();
    const first = await mock.mockApi.publishForm(event.id, draft.revision);
    const moved = await mock.mockApi.saveFormDraft(event.id, first.draft.revision);
    await mock.mockApi.publishForm(event.id, moved.draft.revision);

    const history = await mock.mockApi.listFormVersions(event.id);
    expect(history.items.map((item) => item.versionNumber)).toEqual([2, 1]);
    expect(history.items[0].currentPublished).toBe(true);
    expect(history.currentVersionId).toBe(history.items[0].id);
  });

  it('reports no published form as null, not as an error', async () => {
    const { event } = await eventWithDraft();
    expect((await mock.mockApi.getPublishedForm(event.id)).publishedVersion).toBeNull();
  });

  it('refuses a version reached through the wrong event', async () => {
    const owner = await publishableDraft('Owner');
    const published = await mock.mockApi.publishForm(owner.event.id, owner.draft.revision);
    const other = await newEvent('Impostor');

    await expect(
      mock.mockApi.getFormVersion(other.id, published.version.id),
    ).rejects.toMatchObject({ code: 'FORM_VERSION_NOT_FOUND' });
  });

  it('hands out detached versions, so a cached copy cannot mutate underfoot', async () => {
    const { event, draft } = await publishableDraft();
    const published = await mock.mockApi.publishForm(event.id, draft.revision);

    // Editing the DRAFT proves nothing here — those are different rows. What a
    // real HTTP response can never do is change because the client wrote to it,
    // so write to the response and read the version again.
    const first = await mock.mockApi.getFormVersion(event.id, published.version.id);
    first.version.steps[0].questions[0].label = 'Vandalised';
    first.version.steps[0].questions.pop();
    first.version.steps.pop();

    const second = await mock.mockApi.getFormVersion(event.id, published.version.id);
    expect(second.version.steps).toHaveLength(1);
    expect(second.version.steps[0].questions).toHaveLength(3);
    expect(second.version.steps[0].questions[0].label).toBe('FIRST_NAME');
    expect(second.version.steps[0]).not.toBe(first.version.steps[0]);
  });

  it('blocks scheduling and opening until a form is published', async () => {
    const { event, draft } = await publishableDraft();

    const before = await mock.mockApi.getEvent(event.id);
    expect(before.availableActions).not.toContain('publish');
    expect(
      before.blockedActions.find((entry) => entry.action === 'publish')?.missingFields,
    ).toContain('PUBLISHED_FORM_REQUIRED');
    await expect(mock.mockApi.transitionEvent(event.id, 'publish')).rejects.toMatchObject({
      code: 'EVENT_NOT_READY',
    });

    await mock.mockApi.publishForm(event.id, draft.revision);
    const after = await mock.mockApi.getEvent(event.id);
    expect(after.availableActions).toContain('publish');
    await expect(mock.mockApi.transitionEvent(event.id, 'publish')).resolves.toMatchObject({
      event: { status: 'SCHEDULED' },
    });
  });

  it('a pointer at another event’s version counts as no form at all', async () => {
    const owner = await publishableDraft('Owner');
    const published = await mock.mockApi.publishForm(owner.event.id, owner.draft.revision);

    // SQLite cannot express "and it must be one of MY versions", so the server
    // resolves the pointer instead of trusting it. The mock must agree, or the
    // builder would learn a rule that production does not honour.
    const impostor = await newEvent('Impostor');
    mock.setEventStatus(impostor.id, 'DRAFT', {
      publishedFormVersionId: published.version.id,
    });

    expect((await mock.mockApi.getPublishedForm(impostor.id)).publishedVersion).toBeNull();

    const view = await mock.mockApi.getEvent(impostor.id);
    expect(view.availableActions).not.toContain('publish');
    expect(
      view.blockedActions.find((entry) => entry.action === 'publish')?.missingFields,
    ).toContain('PUBLISHED_FORM_REQUIRED');
    await expect(mock.mockApi.transitionEvent(impostor.id, 'publish')).rejects.toMatchObject({
      code: 'EVENT_NOT_READY',
    });
  });

  it('an event carrying a version can never be deleted', async () => {
    const { event, draft } = await publishableDraft();
    await mock.mockApi.publishForm(event.id, draft.revision);
    await expect(mock.mockApi.deleteEvent(event.id)).rejects.toMatchObject({
      code: 'EVENT_CANNOT_BE_DELETED',
    });
  });
});

// ---------------------------------------------------------------------------
describe('session and scoping', () => {
  it('every form call requires a session', async () => {
    const event = await newEvent();
    vi.resetModules();
    const anonymous = await freshMock(false);

    await expect(anonymous.mockApi.getFormDraft(event.id)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      anonymous.mockApi.createFormStep(event.id, { expectedRevision: 1, title: 'X' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(anonymous.mockApi.previewFormDraft(event.id)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('refuses a step or question reached through the wrong event', async () => {
    const owner = await eventWithStep('Owner');
    const other = await newEvent('Impostor');
    await mock.mockApi.createFormDraft(other.id);

    const stepId = owner.draft.steps[0].id;
    await expect(
      mock.mockApi.updateFormStep(other.id, stepId, { expectedRevision: 1, title: 'Stolen' }),
    ).rejects.toMatchObject({ code: 'FORM_STEP_NOT_FOUND' });
    await expect(
      mock.mockApi.deleteFormStep(other.id, stepId, 1),
    ).rejects.toMatchObject({ code: 'FORM_STEP_NOT_FOUND' });

    // The owner's form is untouched.
    const after = await mock.mockApi.getFormDraft(owner.event.id);
    expect(after.draft?.steps[0].title).toBe('About you');
    expect(after.draft?.revision).toBe(owner.draft.revision);
  });
});

// ---------------------------------------------------------------------------
describe('the draft and its single revision', () => {
  it('reports no form until one is created, and reading never creates it', async () => {
    const event = await newEvent();
    const before = await mock.mockApi.getFormDraft(event.id);
    expect(before.draft).toBeNull();
    expect(before.editable).toBe(true);
    expect(before.availableSystemFields).toContain('EMAIL');

    // Reading left the event deletable, exactly as on the server.
    await expect(mock.mockApi.deleteEvent(event.id)).resolves.toMatchObject({ ok: true });
  });

  it('creating twice returns the same form', async () => {
    const event = await newEvent();
    const first = await mock.mockApi.createFormDraft(event.id);
    const second = await mock.mockApi.createFormDraft(event.id);
    expect(second.draft?.id).toBe(first.draft?.id);
    expect(second.draft?.revision).toBe(1);
  });

  it('previewing a form that does not exist does not create one', async () => {
    const event = await newEvent();
    await expect(mock.mockApi.previewFormDraft(event.id)).rejects.toMatchObject({
      code: 'FORM_DRAFT_NOT_FOUND',
    });
    expect((await mock.mockApi.getFormDraft(event.id)).draft).toBeNull();
  });

  it('moves the revision for a step, a question and an option alike', async () => {
    const { event, draft } = await eventWithStep();
    expect(draft.revision).toBe(2);

    const withQuestion = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'SINGLE_SELECT',
      label: 'Pick',
    });
    expect(withQuestion.draft.revision).toBe(3);

    const question = questionsOf(withQuestion.draft)[0];
    const withOption = await mock.mockApi.createFormOption(event.id, question.id, {
      expectedRevision: withQuestion.draft.revision,
      value: 'a',
      label: 'A',
    });
    expect(withOption.draft.revision).toBe(4);
  });

  it('refuses a stale revision and changes nothing', async () => {
    const { event, draft } = await eventWithStep();
    await expect(
      mock.mockApi.createFormStep(event.id, {
        expectedRevision: draft.revision - 1,
        title: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'FORM_REVISION_CONFLICT' });

    const after = await mock.mockApi.getFormDraft(event.id);
    expect(after.draft?.steps).toHaveLength(1);
    expect(after.draft?.revision).toBe(draft.revision);
  });

  it('hands out detached drafts, so a cached copy cannot mutate underfoot', async () => {
    const { event, draft } = await eventWithStep();
    await mock.mockApi.createFormStep(event.id, {
      expectedRevision: draft.revision,
      title: 'Second',
    });
    expect(draft.steps).toHaveLength(1);
    expect(draft.revision).toBe(2);
  });

  it('an explicit save moves the revision', async () => {
    const { event, draft } = await eventWithStep();
    const saved = await mock.mockApi.saveFormDraft(event.id, draft.revision);
    expect(saved.draft.revision).toBe(draft.revision + 1);
  });
});

// ---------------------------------------------------------------------------
describe('event state parity', () => {
  it('allows editing exactly where the shared table says it may', async () => {
    for (const status of EVENT_STATUSES) {
      vi.resetModules();
      mock = await freshMock();
      const event = await newEvent();
      // The draft is created while the event is still a draft, then the event
      // moves — otherwise a frozen event could never have one at all.
      const created = await mock.mockApi.createFormDraft(event.id);
      mock.setEventStatus(event.id, status as EventStatus);

      const attempt = mock.mockApi.createFormStep(event.id, {
        expectedRevision: created.draft?.revision ?? 1,
        title: 'X',
      });
      if (eventAllowsFormEditing(status)) await expect(attempt).resolves.toBeTruthy();
      else await expect(attempt).rejects.toMatchObject({ code: 'FORM_NOT_EDITABLE' });
    }
  }, 30_000);

  it('reports the form as read-only once the event has closed', async () => {
    const { event } = await eventWithStep();
    mock.setEventStatus(event.id, 'CLOSED');
    const body = await mock.mockApi.getFormDraft(event.id);
    expect(body.editable).toBe(false);
    expect(body.eventStatus).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('questions and system fields', () => {
  it('derives a unique key from the label', async () => {
    const { event, draft } = await eventWithStep();
    const first = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'SHORT_TEXT',
      label: 'Do you smoke?',
    });
    const second = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: first.draft.revision,
      stepId: draft.steps[0].id,
      type: 'SHORT_TEXT',
      label: 'Do you smoke?',
    });
    expect(questionsOf(second.draft).map((question) => question.key)).toEqual([
      'do_you_smoke',
      'do_you_smoke_2',
    ]);
  });

  it('pins a system field key and refuses a duplicate identity', async () => {
    const { event, draft } = await eventWithStep();
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'EMAIL',
      systemField: 'EMAIL',
      label: 'Your email',
    });
    expect(questionsOf(created.draft)[0].key).toBe('email');

    await expect(
      mock.mockApi.createFormQuestion(event.id, {
        expectedRevision: created.draft.revision,
        stepId: draft.steps[0].id,
        type: 'EMAIL',
        systemField: 'EMAIL',
        label: 'Again',
      }),
    ).rejects.toMatchObject({ code: 'FORM_SYSTEM_FIELD_EXISTS' });
  });

  it('refuses a system field whose type is not the one it is pinned to', async () => {
    const { event, draft } = await eventWithStep();
    await expect(
      mock.mockApi.createFormQuestion(event.id, {
        expectedRevision: draft.revision,
        stepId: draft.steps[0].id,
        type: 'SHORT_TEXT',
        systemField: 'EMAIL',
        label: 'Email',
      }),
    ).rejects.toMatchObject({ code: 'FORM_QUESTION_INVALID' });
  });

  it('protects a required system field from a type change, a key change and deletion', async () => {
    const { event, draft } = await eventWithStep();
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'PHONE',
      systemField: 'PHONE',
      label: 'Phone',
      required: true,
    });
    const question = questionsOf(created.draft)[0];
    const revision = created.draft.revision;

    await expect(
      mock.mockApi.updateFormQuestion(event.id, question.id, {
        expectedRevision: revision,
        type: 'SHORT_TEXT',
      }),
    ).rejects.toMatchObject({ code: 'FORM_QUESTION_PROTECTED' });
    await expect(
      mock.mockApi.updateFormQuestion(event.id, question.id, {
        expectedRevision: revision,
        key: 'renamed',
      }),
    ).rejects.toMatchObject({ code: 'FORM_QUESTION_PROTECTED' });
    await expect(
      mock.mockApi.deleteFormQuestion(event.id, question.id, revision),
    ).rejects.toMatchObject({ code: 'FORM_QUESTION_PROTECTED' });

    // Its label is still editable.
    const renamed = await mock.mockApi.updateFormQuestion(event.id, question.id, {
      expectedRevision: revision,
      label: 'Mobile',
    });
    expect(questionsOf(renamed.draft)[0].label).toBe('Mobile');
  });

  it('refuses options where the type has none, and required copy', async () => {
    const { event, draft } = await eventWithStep();
    await expect(
      mock.mockApi.createFormQuestion(event.id, {
        expectedRevision: draft.revision,
        stepId: draft.steps[0].id,
        type: 'YES_NO',
        label: 'Sure?',
        options: [{ value: 'a', label: 'A' }],
      }),
    ).rejects.toMatchObject({ code: 'FORM_OPTION_NOT_ALLOWED' });

    await expect(
      mock.mockApi.createFormQuestion(event.id, {
        expectedRevision: draft.revision,
        stepId: draft.steps[0].id,
        type: 'INFORMATION',
        label: 'Read this',
        required: true,
      }),
    ).rejects.toMatchObject({ code: 'FORM_QUESTION_INVALID' });
  });

  it('duplicates with a fresh key and never as a system field', async () => {
    const { event, draft } = await eventWithStep();
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'EMAIL',
      systemField: 'EMAIL',
      label: 'Email',
    });
    const question = questionsOf(created.draft)[0];

    const copied = await mock.mockApi.duplicateFormQuestion(
      event.id,
      question.id,
      created.draft.revision,
    );
    const all = questionsOf(copied.draft);
    expect(all).toHaveLength(2);
    expect(all[1].systemField).toBe('NONE');
    expect(all[1].key).not.toBe(all[0].key);
  });

  it('moves a question to another step, landing at its end', async () => {
    const { event, draft } = await eventWithStep();
    const twoSteps = await mock.mockApi.createFormStep(event.id, {
      expectedRevision: draft.revision,
      title: 'Second',
    });
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: twoSteps.draft.revision,
      stepId: twoSteps.draft.steps[0].id,
      type: 'SHORT_TEXT',
      label: 'Moving',
    });
    const question = questionsOf(created.draft)[0];

    const moved = await mock.mockApi.updateFormQuestion(event.id, question.id, {
      expectedRevision: created.draft.revision,
      stepId: twoSteps.draft.steps[1].id,
    });
    expect(moved.draft.steps[0].questions).toHaveLength(0);
    expect(moved.draft.steps[1].questions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('steps, options and limits', () => {
  it('refuses to delete a step that still holds questions', async () => {
    const { event, draft } = await eventWithStep();
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'SHORT_TEXT',
      label: 'Held',
    });
    await expect(
      mock.mockApi.deleteFormStep(event.id, draft.steps[0].id, created.draft.revision),
    ).rejects.toMatchObject({ code: 'FORM_STEP_NOT_EMPTY' });
  });

  it('enforces the step ceiling', async () => {
    const { event, draft: initial } = await eventWithDraft();
    let draft = initial;
    for (let index = 0; index < FORM_STEPS_MAX; index++) {
      draft = (
        await mock.mockApi.createFormStep(event.id, {
          expectedRevision: draft.revision,
          title: `Step ${index}`,
        })
      ).draft;
    }
    await expect(
      mock.mockApi.createFormStep(event.id, {
        expectedRevision: draft.revision,
        title: 'One too many',
      }),
    ).rejects.toMatchObject({ code: 'FORM_LIMIT_REACHED' });
  }, 30_000);

  it('refuses a repeated option value', async () => {
    const { event, draft } = await eventWithStep();
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'DROPDOWN',
      label: 'Pick',
      options: [{ value: 'a', label: 'A' }],
    });
    const question = questionsOf(created.draft)[0];

    await expect(
      mock.mockApi.createFormOption(event.id, question.id, {
        expectedRevision: created.draft.revision,
        value: 'a',
        label: 'Another A',
      }),
    ).rejects.toMatchObject({ code: 'FORM_QUESTION_INVALID' });
  });
});

// ---------------------------------------------------------------------------
describe('reorder parity', () => {
  it('applies a complete order and refuses a partial one', async () => {
    const { event, draft } = await eventWithStep('One');
    const two = await mock.mockApi.createFormStep(event.id, {
      expectedRevision: draft.revision,
      title: 'Two',
    });
    const [first, second] = two.draft.steps;

    const reordered = await mock.mockApi.reorderFormSteps(event.id, two.draft.revision, [
      { id: second.id, sortOrder: 0 },
      { id: first.id, sortOrder: 1 },
    ]);
    expect(reordered.draft.steps.map((step) => step.title)).toEqual(['Two', 'About you']);

    await expect(
      mock.mockApi.reorderFormSteps(event.id, reordered.draft.revision, [
        { id: first.id, sortOrder: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'FORM_ORDER_INVALID' });
  });

  it('refuses a repeated id and a repeated position', async () => {
    const { event, draft } = await eventWithStep();
    const stepId = draft.steps[0].id;

    await expect(
      mock.mockApi.reorderFormSteps(event.id, draft.revision, [
        { id: stepId, sortOrder: 0 },
        { id: stepId, sortOrder: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'FORM_ORDER_INVALID' });
  });
});

// ---------------------------------------------------------------------------
describe('preview parity', () => {
  it('renders only active questions and active options', async () => {
    const { event, draft } = await eventWithStep('Page one');
    const created = await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'SINGLE_SELECT',
      label: 'Pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const question = questionsOf(created.draft)[0];
    const hidden = await mock.mockApi.updateFormOption(
      event.id,
      question.id,
      question.options[1].id,
      { expectedRevision: created.draft.revision, active: false },
    );

    const preview = await mock.mockApi.previewFormDraft(event.id);
    expect(preview.steps[0].questions[0].options).toEqual([{ value: 'a', label: 'A' }]);
    expect(preview.revision).toBe(hidden.draft.revision);
    expect(preview.problems).toEqual([]);
  });

  it('reports the same problems the server does', async () => {
    const { event } = await eventWithDraft();
    const empty = await mock.mockApi.previewFormDraft(event.id);
    expect(empty.problems.map((problem) => problem.code)).toContain('NO_STEPS');

    const draft = (
      await mock.mockApi.createFormStep(event.id, {
        expectedRevision: empty.revision,
        title: 'Page',
      })
    ).draft;
    const withEmptyStep = await mock.mockApi.previewFormDraft(event.id);
    expect(withEmptyStep.problems.map((problem) => problem.code)).toContain('EMPTY_STEP');

    await mock.mockApi.createFormQuestion(event.id, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      type: 'DROPDOWN',
      label: 'No choices',
    });
    const withSelect = await mock.mockApi.previewFormDraft(event.id);
    expect(withSelect.problems.map((problem) => problem.code)).toContain(
      'SELECT_WITHOUT_OPTIONS',
    );
  });
});

// ---------------------------------------------------------------------------
describe('event integration parity', () => {
  it('an event carrying a form can no longer be deleted', async () => {
    const event = await newEvent();
    await expect(mock.mockApi.deleteEvent(event.id)).resolves.toMatchObject({ ok: true });

    const second = await newEvent('Has a form');
    await mock.mockApi.createFormDraft(second.id);
    await expect(mock.mockApi.deleteEvent(second.id)).rejects.toMatchObject({
      code: 'EVENT_CANNOT_BE_DELETED',
    });
    expect((await mock.mockApi.getEvent(second.id)).canDelete).toBe(false);
  });
});
