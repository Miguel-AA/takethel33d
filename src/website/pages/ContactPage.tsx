// Contact — "/contact". Captures intent from interested businesses.
//
// IMPORTANT: this is a frontend-only placeholder form. It is NOT wired to a
// backend yet; submitting only shows a local confirmation. An alternative CTA
// routes to the existing app at /events.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useLandingCopy } from '../useLandingCopy';
import { CheckIcon } from '../icons';
import { PageHero } from '../components/PageHero';

export function ContactPage() {
  const p = useLandingCopy().pages.contact;
  const f = p.form;
  const [submitted, setSubmitted] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Placeholder: no backend integration yet. Show a local confirmation only.
    setSubmitted(true);
  }

  return (
    <>
      <PageHero
        id="contact-page-title"
        kicker={p.hero.kicker}
        title={p.hero.title}
        subtitle={p.hero.subtitle}
      />

      <section
        aria-labelledby="contact-page-title"
        className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:py-16"
      >
        {submitted ? (
          <div className="card p-7 text-center sm:p-10">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-brand-400/30 bg-brand-500/10 text-brand-600">
              <CheckIcon className="h-7 w-7" />
            </span>
            <h2 className="mt-5 text-xl font-bold text-slate-900">{p.success.title}</h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-600">{p.success.body}</p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <button type="button" onClick={() => setSubmitted(false)} className="btn-secondary px-5 py-2.5 text-sm">
                {p.success.reset}
              </button>
              <Link to="/events" className="btn-primary px-5 py-2.5 text-sm">
                {p.alt.cta}
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="card p-6 sm:p-8" noValidate>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="contact-name" className="label">
                  {f.name}
                </label>
                <input id="contact-name" name="name" type="text" required autoComplete="name" placeholder={f.namePlaceholder} className="input" />
              </div>
              <div>
                <label htmlFor="contact-email" className="label">
                  {f.email}
                </label>
                <input id="contact-email" name="email" type="email" required autoComplete="email" placeholder={f.emailPlaceholder} className="input" />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="contact-business" className="label">
                  {f.business}
                </label>
                <input id="contact-business" name="business" type="text" required autoComplete="organization" placeholder={f.businessPlaceholder} className="input" />
              </div>

              <div>
                <label htmlFor="contact-industry" className="label">
                  {f.industry}
                </label>
                <select id="contact-industry" name="industry" required defaultValue="" className="input">
                  <option value="" disabled>
                    {f.industryDefault}
                  </option>
                  {f.industries.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="contact-goal" className="label">
                  {f.goal}
                </label>
                <select id="contact-goal" name="goal" required defaultValue="" className="input">
                  <option value="" disabled>
                    {f.goalDefault}
                  </option>
                  {f.goals.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="contact-message" className="label">
                  {f.message}
                </label>
                <textarea
                  id="contact-message"
                  name="message"
                  rows={4}
                  placeholder={f.messagePlaceholder}
                  className="input resize-y"
                />
              </div>
            </div>

            <button type="submit" className="btn-primary mt-6 w-full px-5 py-2.5 text-sm">
              {f.submit}
            </button>
            <p className="mt-4 text-center text-xs text-slate-500">{p.disclaimer}</p>
          </form>
        )}

        {/* Alternative CTA into the existing app */}
        <p className="mt-8 text-center text-sm text-slate-600">
          {p.alt.text}{' '}
          <Link to="/events" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
            {p.alt.cta}
          </Link>
        </p>
      </section>
    </>
  );
}
