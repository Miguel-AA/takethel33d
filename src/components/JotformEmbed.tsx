import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/I18nProvider';
import { RegisterForm } from './RegisterForm';
import { ErrorBanner } from './ErrorBanner';
import { Spinner } from './Spinner';

const HANDLER_SRC = 'https://cdn.jotfor.ms/s/umd/latest/for-form-embed-handler.js';
const USE_MOCK =
  import.meta.env.VITE_USE_MOCK_API === 'true' ||
  (import.meta.env.DEV &&
    import.meta.env.VITE_USE_MOCK_API !== 'false' &&
    !import.meta.env.VITE_API_BASE_URL);

// Production form ID (insurance lead form), overridable via Vite env vars.
const DEFAULT_FORM_ID_ES = '261465857224059';
const DEFAULT_FORM_ID_EN = '261465857224059';

declare global {
  interface Window {
    jotformEmbedHandler?: (selector: string, origin: string) => void;
  }
}

let handlerScriptPromise: Promise<void> | null = null;

function loadHandlerScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.jotformEmbedHandler) return Promise.resolve();
  if (handlerScriptPromise) return handlerScriptPromise;
  handlerScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${HANDLER_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Jotform handler')));
      return;
    }
    const script = document.createElement('script');
    script.src = HANDLER_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Jotform handler'));
    document.head.appendChild(script);
  });
  return handlerScriptPromise;
}

export function JotformEmbed() {
  const { locale } = useTranslation();

  if (USE_MOCK) {
    return <RegisterForm />;
  }

  const formId =
    locale === 'en'
      ? (import.meta.env.VITE_JOTFORM_FORM_ID_EN || DEFAULT_FORM_ID_EN)
      : (import.meta.env.VITE_JOTFORM_FORM_ID_ES || DEFAULT_FORM_ID_ES);

  // Defense-in-depth: the defaults above mean formId is always set in
  // practice, but if someone explicitly blanks out the env var AND the
  // default, fall back to dev form / friendly error rather than crashing.
  if (!formId) {
    if (import.meta.env.DEV) {
      return <RegisterForm />;
    }
    return (
      <div className="space-y-4">
        <ErrorBanner
          message={
            locale === 'en'
              ? 'Registration is not available yet. Please check back shortly.'
              : 'El registro todavía no está disponible. Vuelve a intentarlo en unos minutos.'
          }
        />
        <p className="text-sm text-slate-500">
          {locale === 'en'
            ? 'The event team is finishing the form setup.'
            : 'El equipo del evento está terminando la configuración del formulario.'}
        </p>
      </div>
    );
  }

  const title =
    locale === 'en'
      ? 'Take the L33d Premium Lead Form'
      : 'Formulario premium de leads - Take the L33d';

  return <JotformIframe formId={formId} title={title} />;
}

function JotformIframe({ formId, title }: { formId: string; title: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setStatus('loading');
    let cancelled = false;
    loadHandlerScript()
      .then(() => {
        if (cancelled) return;
        try {
          window.jotformEmbedHandler?.(
            `iframe[id='JotFormIFrame-${formId}']`,
            'https://form.jotform.com/',
          );
        } catch {
          /* handler attaches via querySelector; ignore */
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [formId]);

  return (
    <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black/30 backdrop-blur-xl">
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-black/80 py-3 text-xs text-slate-300 backdrop-blur-xl">
          <Spinner /> <span>Cargando formulario...</span>
        </div>
      )}
      {status === 'error' && (
        <div className="p-4">
          <ErrorBanner message="No se pudo cargar el formulario. Intenta recargar la página." />
        </div>
      )}
      <iframe
        id={`JotFormIFrame-${formId}`}
        title={title}
        src={`https://form.jotform.com/${formId}`}
        allow="geolocation; microphone; camera; fullscreen; payment"
        allowFullScreen
        scrolling="no"
        frameBorder={0}
        style={{
          minWidth: '100%',
          maxWidth: '100%',
          height: '539px',
          border: 'none',
        }}
        onLoad={() => {
          setStatus('ready');
          // Match Jotform's recommended snippet behavior.
          try {
            window.scrollTo(0, 0);
          } catch {
            /* ignore */
          }
        }}
      />
    </div>
  );
}
