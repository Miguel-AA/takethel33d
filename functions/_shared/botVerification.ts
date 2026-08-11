// The seam where bot verification will plug in.
//
// NO CAPTCHA IS IMPLEMENTED, and that is a decision rather than an omission.
// Turnstile, reCAPTCHA and hCaptcha all require an account, a site key, a
// secret and a third-party script on the participant's page — a provisioning
// and privacy decision that belongs to whoever runs the deployment, not to this
// phase. What phase 9 owes them is a place to put it that does not require
// reopening the submission handler.
//
// WHY A SEAM RATHER THAN NOTHING: adding a verification step later means
// deciding where it goes relative to rate limiting, token verification, payload
// parsing and the registration batch. Deciding that now — while the ordering
// constraints are fresh and testable — is most of the work. The implementation
// that replaces `PassThroughBotVerificationService` inherits a call site that
// is already in the right place and already covered by tests.
//
// WHY IT RETURNS A VERDICT RATHER THAN THROWING: a bot check that fails open on
// a provider outage is usually the right trade for a public form, and a caller
// that must read `ok` cannot accidentally ignore the result the way it could
// ignore a promise that only sometimes rejects.

/**
 * The contract a real provider will satisfy.
 *
 * It receives the whole `Request` rather than a token string so an
 * implementation can read whichever header, cookie or body field its provider
 * uses without changing this interface — Turnstile reads a form field,
 * others read a header.
 */
export interface BotVerificationService {
  verify(request: Request): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * The implementation phase 9 ships: it verifies nothing and admits everyone.
 *
 * Deliberately NOT named `NoopBotVerificationService`. "Pass-through" states
 * that traffic passes through unexamined, which is what an operator reading a
 * deployment needs to know. The class exists so that the day a provider is
 * chosen, the change is one constructor argument and the ordering is already
 * proven.
 */
export class PassThroughBotVerificationService implements BotVerificationService {
  async verify(request: Request): Promise<{ ok: boolean; reason?: string }> {
    // The request is deliberately not inspected. Naming the parameter rather
    // than dropping it keeps the signature identical to the one a real provider
    // will implement, so replacing this class changes nothing at the call site.
    void request;
    return { ok: true };
  }
}
