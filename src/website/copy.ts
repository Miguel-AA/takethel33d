// Self-contained bilingual copy for the marketing website.
// Kept isolated from the app's shared i18n JSON so the website can evolve
// independently. Reads the current locale from the existing I18nProvider.
//
// The website is multipage (Home, Benefits, How it works, Industries, Pricing,
// Contact). All marketing routes live under src/website; "Events" links out to
// the existing app at /events and is NOT a marketing section.
//
// NOTE: Metrics, testimonials, logos and pricing below are clearly-marked
// PLACEHOLDERS. Replace them with real, approved data before going to production.
import type { IconName } from './icons';

export type LandingLocale = 'es' | 'en';

interface NavCopy {
  home: string;
  benefits: string;
  how: string;
  industries: string;
  pricing: string;
  contact: string;
  events: string;
  /** Primary marketing CTA shown in the header (-> /contact). */
  getLeads: string;
  /** Accessible label for the mobile burger menu toggle. */
  menu: string;
}
interface HeroMetric {
  label: string;
  value: string;
}
interface HeroRow {
  name: string;
  tag: string;
  status: string;
  /** Placeholder estimated opportunity value (clearly demo data). */
  value: string;
}
interface HeroCopy {
  badge: string;
  titleStart: string;
  titleEm: string;
  titleEnd: string;
  subtitle: string;
  ctaPrimary: string;
  ctaSecondary: string;
  proof: string;
  mockup: {
    label: string;
    live: string;
    metrics: HeroMetric[];
    rows: HeroRow[];
    note: string;
  };
}
interface IconItem {
  icon: IconName;
  title: string;
  body: string;
}
interface BenefitsCopy {
  kicker: string;
  title: string;
  subtitle: string;
  items: IconItem[];
}
interface Step {
  n: string;
  title: string;
  body: string;
  icon?: IconName;
}
interface HowCopy {
  kicker: string;
  title: string;
  subtitle: string;
  steps: Step[];
}
interface FeaturesCopy {
  kicker: string;
  title: string;
  subtitle: string;
  items: IconItem[];
}
interface Metric {
  value: string;
  label: string;
}
interface Testimonial {
  quote: string;
  author: string;
  role: string;
}
interface TrustCopy {
  kicker: string;
  title: string;
  subtitle: string;
  metrics: Metric[];
  logosLabel: string;
  logoPlaceholder: string;
  testimonials: Testimonial[];
  disclaimer: string;
}
interface FinalCtaCopy {
  title: string;
  subtitle: string;
  ctaPrimary: string;
  ctaSecondary: string;
}
interface FooterLink {
  label: string;
  /** Internal route ("/...") rendered as a <Link>; anything else as an <a>. */
  to: string;
}
interface FooterColumn {
  title: string;
  links: FooterLink[];
}
interface FooterCopy {
  tagline: string;
  columns: FooterColumn[];
  rights: string;
}

/** Reusable heading for an interior marketing page. */
interface PageHero {
  kicker: string;
  title: string;
  /** Phrase within `title` rendered in the blue accent gradient (exact substring of `title`). */
  titleEm: string;
  subtitle: string;
  /** Optional CTA buttons + proof line, mirroring the home hero. The page
      component supplies the link targets; copy supplies the labels. */
  ctaPrimary?: string;
  ctaSecondary?: string;
  proof?: string;
}
/** Labels for a reusable closing CTA band; the page supplies the targets. */
interface CtaBand {
  title: string;
  subtitle: string;
  primary: string;
  secondary: string;
}
interface BenefitsPageCopy {
  hero: PageHero;
  items: IconItem[];
  cta: CtaBand;
}
interface HowPageCopy {
  hero: PageHero;
  steps: Step[];
  cta: CtaBand;
}
interface IndustriesPageCopy {
  hero: PageHero;
  items: IconItem[];
  cta: CtaBand;
}
interface Plan {
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  cta: string;
  featured?: boolean;
  badge?: string;
}
interface PricingPageCopy {
  hero: PageHero;
  note: string;
  plans: Plan[];
  cta: CtaBand;
}
interface ContactFormCopy {
  name: string;
  email: string;
  business: string;
  industry: string;
  goal: string;
  message: string;
  namePlaceholder: string;
  emailPlaceholder: string;
  businessPlaceholder: string;
  messagePlaceholder: string;
  industryDefault: string;
  goalDefault: string;
  industries: string[];
  goals: string[];
  submit: string;
}
interface ContactPageCopy {
  hero: PageHero;
  form: ContactFormCopy;
  success: { title: string; body: string; reset: string };
  alt: { text: string; cta: string };
  disclaimer: string;
}
interface PagesCopy {
  benefits: BenefitsPageCopy;
  how: HowPageCopy;
  industries: IndustriesPageCopy;
  pricing: PricingPageCopy;
  contact: ContactPageCopy;
}

export interface LandingCopy {
  nav: NavCopy;
  hero: HeroCopy;
  benefits: BenefitsCopy;
  how: HowCopy;
  features: FeaturesCopy;
  trust: TrustCopy;
  finalCta: FinalCtaCopy;
  footer: FooterCopy;
  pages: PagesCopy;
}

export const landingCopy: Record<LandingLocale, LandingCopy> = {
  es: {
    nav: {
      home: 'Inicio',
      benefits: 'Beneficios',
      how: 'Cómo funciona',
      industries: 'Industrias',
      pricing: 'Planes',
      contact: 'Contacto',
      events: 'Events',
      getLeads: 'Quiero más leads',
      menu: 'Menú',
    },
    hero: {
      badge: 'Leads y oportunidades para negocios',
      titleStart: 'Convierte el interés en',
      titleEm: 'leads calificados',
      titleEnd: 'para tu negocio',
      subtitle:
        'Te entregamos un flujo organizado de leads con intención para que tu equipo dedique su tiempo a cerrar, no a buscar contactos en frío.',
      ctaPrimary: 'Quiero más leads',
      ctaSecondary: 'Ver cómo funciona',
      proof: 'Más reservas, consultas y ventas a partir del interés que ya existe.',
      mockup: {
        label: 'Pipeline de leads',
        live: 'En vivo',
        metrics: [
          { label: 'Leads del mes', value: '1,248' },
          { label: 'Con intención', value: '612' },
          { label: 'Accionables', value: '34%' },
        ],
        rows: [
          { name: 'Nuevo lead', tag: 'Solicitó información', status: 'Calificado', value: '$1.2k' },
          { name: 'Lead con intención', tag: 'Pidió cotización', status: 'Listo', value: '$3.4k' },
          { name: 'Seguimiento', tag: 'Agendó llamada', status: 'Seguimiento', value: '$2.1k' },
        ],
        note: 'Datos de demostración',
      },
    },
    benefits: {
      kicker: 'Beneficios',
      title: 'Todo lo que tu negocio necesita para crecer con leads de calidad',
      subtitle:
        'Menos esfuerzo manual, más oportunidades reales y un proceso que tu equipo realmente quiere usar.',
      items: [
        {
          icon: 'target',
          title: 'Prospectos con intención',
          body: 'Llega a personas que ya mostraron interés y filtra el ruido antes de que llegue a tu equipo.',
        },
        {
          icon: 'bolt',
          title: 'Respuesta más rápida',
          body: 'Cada lead llega organizado para que respondas mientras el interés sigue caliente.',
        },
        {
          icon: 'layers',
          title: 'Todo en un solo lugar',
          body: 'Centraliza la captación, la organización y el seguimiento sin saltar entre herramientas.',
        },
        {
          icon: 'chart',
          title: 'Crecimiento más predecible',
          body: 'Un flujo constante de oportunidades hace más fácil planear y escalar con confianza.',
        },
        {
          icon: 'shield',
          title: 'Datos protegidos',
          body: 'Captación segura y manejo transparente que genera confianza desde el primer contacto.',
        },
        {
          icon: 'clock',
          title: 'Ahorra tiempo',
          body: 'Deja de perseguir contactos en frío y enfoca las horas en lo que realmente cierra ventas.',
        },
      ],
    },
    how: {
      kicker: 'Cómo funciona',
      title: 'De objetivo a oportunidad en pasos simples',
      subtitle: 'Un proceso claro, transparente y diseñado para escalar contigo.',
      steps: [
        {
          n: '01',
          icon: 'target',
          title: 'Define tu objetivo',
          body: 'Nos dices a qué tipo de cliente quieres llegar y qué resultado buscas.',
        },
        {
          n: '02',
          icon: 'funnel',
          title: 'Atraemos oportunidades',
          body: 'Identificamos y captamos contactos con intención real, listos para tu equipo.',
        },
        {
          n: '03',
          icon: 'bell',
          title: 'Recibes prospectos accionables',
          body: 'Tu equipo recibe leads priorizados y con contexto para cerrar más rápido.',
        },
      ],
    },
    features: {
      kicker: 'Características',
      title: 'Una plataforma, todo el ciclo del lead',
      subtitle: 'Las piezas clave para captar, ordenar y convertir, trabajando juntas.',
      items: [
        {
          icon: 'funnel',
          title: 'Captación',
          body: 'Puntos de entrada optimizados para convertir interés en leads accionables.',
        },
        {
          icon: 'layers',
          title: 'Organización',
          body: 'Una base ordenada y con contexto para priorizar cada oportunidad.',
        },
        {
          icon: 'bell',
          title: 'Seguimiento',
          body: 'Estados claros para que ningún lead se enfríe ni se pierda.',
        },
        {
          icon: 'bolt',
          title: 'Eficiencia',
          body: 'Menos trabajo manual de búsqueda y más foco del equipo en cerrar.',
        },
      ],
    },
    trust: {
      kicker: 'Confianza',
      title: 'Negocios que crecen con datos, no con suposiciones',
      subtitle: 'Un proceso pensado para demostrar impacto desde el primer mes.',
      metrics: [
        { value: '10k+', label: 'Leads procesados' },
        { value: '34%', label: 'Tasa accionable' },
        { value: '<24h', label: 'Tiempo de respuesta' },
        { value: '99.9%', label: 'Disponibilidad' },
      ],
      logosLabel: 'Tu logo y el de tus clientes podrían ir aquí',
      logoPlaceholder: 'Tu logo',
      testimonials: [
        {
          quote:
            '“Pasamos de perseguir contactos fríos a recibir oportunidades listas para cerrar. El cambio fue inmediato.”',
          author: 'Nombre Apellido',
          role: 'Cargo · Empresa',
        },
        {
          quote:
            '“Por fin tenemos visibilidad real de nuestros leads y de qué los convierte. El equipo trabaja con foco.”',
          author: 'Nombre Apellido',
          role: 'Cargo · Empresa',
        },
      ],
      disclaimer: 'Métricas, logos y testimonios de ejemplo — editables antes de producción.',
    },
    finalCta: {
      title: '¿Listo para llenar tu agenda con oportunidades reales?',
      subtitle: 'Convierte el interés en conversaciones con clientes potenciales y enfoca a tu equipo en cerrar.',
      ctaPrimary: 'Quiero más leads',
      ctaSecondary: 'Ver cómo funciona',
    },
    footer: {
      tagline: 'Leads y oportunidades para negocios que quieren crecer.',
      columns: [
        {
          title: 'Sitio',
          links: [
            { label: 'Beneficios', to: '/benefits' },
            { label: 'Cómo funciona', to: '/how-it-works' },
            { label: 'Industrias', to: '/industries' },
            { label: 'Planes', to: '/pricing' },
          ],
        },
        {
          title: 'Empezar',
          links: [
            { label: 'Contacto', to: '/contact' },
            { label: 'Events', to: '/events' },
          ],
        },
        {
          title: 'Legal',
          links: [
            { label: 'Privacidad', to: '#' },
            { label: 'Términos', to: '#' },
            { label: 'Cookies', to: '#' },
          ],
        },
      ],
      rights: 'Todos los derechos reservados.',
    },
    pages: {
      benefits: {
        hero: {
          kicker: 'Beneficios',
          title: 'Más oportunidades, menos tiempo perdido',
          titleEm: 'oportunidades',
          subtitle:
            'Un flujo constante de leads relevantes ayuda a tu negocio a crecer con menos esfuerzo manual y más foco en cerrar.',
          ctaPrimary: 'Quiero más leads',
          ctaSecondary: 'Ver cómo funciona',
          proof: 'Más reservas, consultas y ventas a partir del interés que ya existe.',
        },
        items: [
          {
            icon: 'chart',
            title: 'Más oportunidades comerciales',
            body: 'Mantén un flujo constante de prospectos para que tu negocio no dependa de un solo canal.',
          },
          {
            icon: 'clock',
            title: 'Menos tiempo buscando clientes',
            body: 'Deja de perseguir contactos en frío manualmente y recibe oportunidades listas para contactar.',
          },
          {
            icon: 'target',
            title: 'Prospectos con intención',
            body: 'Llega a personas que ya mostraron interés, no a listas frías sin contexto.',
          },
          {
            icon: 'bell',
            title: 'Mejor seguimiento',
            body: 'Cada lead llega organizado y con contexto para que ninguno se enfríe ni se pierda.',
          },
          {
            icon: 'bolt',
            title: 'Mayor eficiencia del equipo',
            body: 'Tu equipo dedica su energía a conversar y cerrar, no a tareas repetitivas de búsqueda.',
          },
          {
            icon: 'layers',
            title: 'Crecimiento más predecible',
            body: 'Con un flujo organizado de oportunidades es más fácil planear y escalar con confianza.',
          },
          {
            icon: 'sparkle',
            title: 'Llena tu agenda',
            body: 'Genera más reservas, consultas o ventas convirtiendo el interés en conversaciones reales.',
          },
          {
            icon: 'shield',
            title: 'Enfócate en cerrar',
            body: 'El negocio se concentra en atender prospectos accionables en lugar de buscar manualmente.',
          },
        ],
        cta: {
          title: '¿Quieres más oportunidades para tu negocio?',
          subtitle: 'Hablemos de cómo un flujo constante de leads puede ayudarte a crecer.',
          primary: 'Hablar con el equipo',
          secondary: 'Ver cómo funciona',
        },
      },
      how: {
        hero: {
          kicker: 'Cómo funciona',
          title: 'De objetivo a cliente, paso a paso',
          titleEm: 'cliente',
          subtitle: 'Un proceso simple y transparente para convertir interés en oportunidades accionables.',
          ctaPrimary: 'Empezar a recibir leads',
          ctaSecondary: 'Ver planes',
          proof: 'Un proceso claro, transparente y diseñado para escalar contigo.',
        },
        steps: [
          {
            n: '01',
            title: 'Defines tu objetivo',
            body: 'Nos dices qué tipo de cliente buscas y qué resultado quieres lograr.',
          },
          {
            n: '02',
            title: 'Atraemos oportunidades',
            body: 'Identificamos y captamos personas con interés real en lo que ofreces.',
          },
          {
            n: '03',
            title: 'Organizamos los leads',
            body: 'Cada prospecto se ordena con contexto para que sea fácil de priorizar.',
          },
          {
            n: '04',
            title: 'Recibes prospectos accionables',
            body: 'Tu negocio recibe leads listos para contactar, sin trabajo manual de búsqueda.',
          },
          {
            n: '05',
            title: 'Das seguimiento y conviertes',
            body: 'Te enfocas en conversar y cerrar mientras el flujo de oportunidades continúa.',
          },
        ],
        cta: {
          title: '¿Listo para poner el proceso a trabajar?',
          subtitle: 'Empieza a recibir oportunidades accionables para tu negocio.',
          primary: 'Empezar ahora',
          secondary: 'Ver planes',
        },
      },
      industries: {
        hero: {
          kicker: 'Industrias',
          title: 'Leads para distintos tipos de negocio',
          titleEm: 'Leads',
          subtitle:
            'Si tu negocio necesita más clientes, reservas o consultas, un flujo de leads relevante puede ayudar.',
          ctaPrimary: 'Quiero leads para mi negocio',
          ctaSecondary: 'Ver beneficios',
          proof: 'Leads relevantes para tu tipo de negocio.',
        },
        items: [
          {
            icon: 'calendar',
            title: 'Eventos',
            body: 'Llena cupos y capta asistentes interesados para tus próximos eventos.',
          },
          {
            icon: 'briefcase',
            title: 'Servicios profesionales',
            body: 'Recibe consultas de clientes que buscan asesoría, despachos o servicios especializados.',
          },
          {
            icon: 'utensils',
            title: 'Restaurantes y catering',
            body: 'Genera reservas y solicitudes de catering de clientes en tu zona.',
          },
          {
            icon: 'heart',
            title: 'Salud y bienestar',
            body: 'Atrae pacientes y clientes que buscan agendar citas o servicios de bienestar.',
          },
          {
            icon: 'home',
            title: 'Inmobiliaria',
            body: 'Conecta con interesados en comprar, rentar o vender propiedades.',
          },
          {
            icon: 'book',
            title: 'Educación y cursos',
            body: 'Capta estudiantes y prospectos interesados en tus programas o cursos.',
          },
          {
            icon: 'wrench',
            title: 'Servicios locales',
            body: 'Recibe solicitudes de clientes que necesitan servicios en su zona.',
          },
          {
            icon: 'building',
            title: 'Negocios B2B',
            body: 'Genera oportunidades comerciales con otras empresas que necesitan tu solución.',
          },
        ],
        cta: {
          title: '¿No ves tu industria?',
          subtitle: 'El proceso se adapta a la mayoría de negocios que necesitan más clientes. Hablemos.',
          primary: 'Hablar con el equipo',
          secondary: 'Ver cómo funciona',
        },
      },
      pricing: {
        hero: {
          kicker: 'Planes',
          title: 'Planes pensados para crecer contigo',
          titleEm: 'crecer contigo',
          subtitle:
            'Elige un punto de partida y escala a medida que crece tu negocio. Precios y condiciones editables.',
          ctaPrimary: 'Hablar con el equipo',
          ctaSecondary: 'Ver cómo funciona',
          proof: 'Planes simples que crecen con tu negocio.',
        },
        note: 'Los precios mostrados son ejemplos. Contáctanos para una cotización a la medida de tu negocio.',
        plans: [
          {
            name: 'Starter',
            price: 'Desde ___',
            period: '/mes',
            description: 'Para negocios que empiezan a generar leads.',
            features: ['Flujo inicial de leads', 'Organización básica', 'Soporte por correo'],
            cta: 'Empezar',
          },
          {
            name: 'Growth',
            price: 'Desde ___',
            period: '/mes',
            description: 'Para negocios que quieren acelerar su crecimiento.',
            features: [
              'Mayor volumen de leads',
              'Priorización de prospectos',
              'Seguimiento organizado',
              'Soporte prioritario',
            ],
            cta: 'Empezar',
            featured: true,
            badge: 'Más popular',
          },
          {
            name: 'Pro',
            price: 'Contactar',
            description: 'Para equipos con necesidades a medida.',
            features: [
              'Volumen a medida',
              'Integraciones avanzadas',
              'Acompañamiento dedicado',
              'Reportes personalizados',
            ],
            cta: 'Contactar',
          },
        ],
        cta: {
          title: '¿No estás seguro de qué plan elegir?',
          subtitle: 'Cuéntanos tu objetivo y te ayudamos a encontrar el punto de partida ideal.',
          primary: 'Hablar con el equipo',
          secondary: 'Ver cómo funciona',
        },
      },
      contact: {
        hero: {
          kicker: 'Contacto',
          title: 'Hablemos de cómo conseguir más leads',
          titleEm: 'más leads',
          subtitle: 'Cuéntanos sobre tu negocio y tu objetivo. Te contactaremos para ayudarte a empezar.',
        },
        form: {
          name: 'Nombre',
          email: 'Email',
          business: 'Nombre del negocio',
          industry: 'Industria',
          goal: 'Objetivo principal',
          message: 'Mensaje',
          namePlaceholder: 'Tu nombre',
          emailPlaceholder: 'tu@email.com',
          businessPlaceholder: 'Nombre de tu negocio',
          messagePlaceholder: 'Cuéntanos qué quieres lograr',
          industryDefault: 'Selecciona una industria',
          goalDefault: 'Selecciona un objetivo',
          industries: [
            'Eventos',
            'Servicios profesionales',
            'Restaurantes y catering',
            'Salud y bienestar',
            'Inmobiliaria',
            'Educación y cursos',
            'Servicios locales',
            'Negocios B2B',
            'Otra',
          ],
          goals: ['Más reservas', 'Más consultas', 'Más ventas', 'Más clientes', 'Llenar mi agenda', 'Otro'],
          submit: 'Enviar',
        },
        success: {
          title: '¡Gracias por tu interés!',
          body: 'Este formulario es una demostración: aún no se envían datos a ningún servidor. Pronto conectaremos el envío real.',
          reset: 'Enviar otro mensaje',
        },
        alt: {
          text: '¿Prefieres explorar la app directamente?',
          cta: 'Ir a Events',
        },
        disclaimer: 'Formulario de demostración — aún no conectado a un servidor.',
      },
    },
  },
  en: {
    nav: {
      home: 'Home',
      benefits: 'Benefits',
      how: 'How it works',
      industries: 'Industries',
      pricing: 'Pricing',
      contact: 'Contact',
      events: 'Events',
      getLeads: 'Get more leads',
      menu: 'Menu',
    },
    hero: {
      badge: 'Leads and opportunities for businesses',
      titleStart: 'Turn interest into',
      titleEm: 'qualified leads',
      titleEnd: 'for your business',
      subtitle:
        'We deliver an organized flow of intent-driven leads so your team spends its time closing deals, not chasing cold contacts.',
      ctaPrimary: 'Get more leads',
      ctaSecondary: 'See how it works',
      proof: 'More bookings, inquiries and sales from the interest that already exists.',
      mockup: {
        label: 'Lead Pipeline',
        live: 'Live',
        metrics: [
          { label: 'Leads this month', value: '1,248' },
          { label: 'With intent', value: '612' },
          { label: 'Actionable', value: '34%' },
        ],
        rows: [
          { name: 'New lead', tag: 'Requested info', status: 'Qualified', value: '$1.2k' },
          { name: 'Intent-driven lead', tag: 'Asked for a quote', status: 'Ready', value: '$3.4k' },
          { name: 'Follow-up', tag: 'Booked a call', status: 'Follow-up', value: '$2.1k' },
        ],
        note: 'Demo data',
      },
    },
    benefits: {
      kicker: 'Benefits',
      title: 'Everything your business needs to grow with quality leads',
      subtitle:
        'Less manual work, more real opportunities, and a process your team actually wants to use.',
      items: [
        {
          icon: 'target',
          title: 'Prospects with intent',
          body: 'Reach people who already showed interest and filter out the noise before it reaches your team.',
        },
        {
          icon: 'bolt',
          title: 'Faster response',
          body: 'Every lead arrives organized so you respond while interest is still hot.',
        },
        {
          icon: 'layers',
          title: 'Everything in one place',
          body: 'Centralize capture, organization and follow-up without jumping between tools.',
        },
        {
          icon: 'chart',
          title: 'More predictable growth',
          body: 'A steady flow of opportunities makes it easier to plan and scale with confidence.',
        },
        {
          icon: 'shield',
          title: 'Protected data',
          body: 'Secure capture and transparent handling that build trust from the first touch.',
        },
        {
          icon: 'clock',
          title: 'Save time',
          body: 'Stop chasing cold contacts and focus your hours on what actually closes deals.',
        },
      ],
    },
    how: {
      kicker: 'How it works',
      title: 'From goal to opportunity in simple steps',
      subtitle: 'A clear, transparent process designed to scale with you.',
      steps: [
        {
          n: '01',
          icon: 'target',
          title: 'Define your goal',
          body: 'Tell us which customers you want to reach and what outcome you’re after.',
        },
        {
          n: '02',
          icon: 'funnel',
          title: 'We attract opportunities',
          body: 'We identify and capture contacts with real intent, ready for your team.',
        },
        {
          n: '03',
          icon: 'bell',
          title: 'You receive actionable prospects',
          body: 'Your team gets prioritized leads with context to close faster.',
        },
      ],
    },
    features: {
      kicker: 'Features',
      title: 'One platform, the entire lead lifecycle',
      subtitle: 'The key pieces to capture, organize and convert, working together.',
      items: [
        {
          icon: 'funnel',
          title: 'Capture',
          body: 'Optimized entry points that turn interest into actionable leads.',
        },
        {
          icon: 'layers',
          title: 'Organization',
          body: 'A clean base with context to prioritize every opportunity.',
        },
        {
          icon: 'bell',
          title: 'Follow-up',
          body: 'Clear statuses so no lead goes cold or gets lost.',
        },
        {
          icon: 'bolt',
          title: 'Efficiency',
          body: 'Less manual prospecting and more team focus on closing.',
        },
      ],
    },
    trust: {
      kicker: 'Trust',
      title: 'Businesses that grow with data, not guesswork',
      subtitle: 'A process designed to prove impact from the very first month.',
      metrics: [
        { value: '10k+', label: 'Leads processed' },
        { value: '34%', label: 'Actionable rate' },
        { value: '<24h', label: 'Response time' },
        { value: '99.9%', label: 'Uptime' },
      ],
      logosLabel: 'Your logo and your clients’ logos could go here',
      logoPlaceholder: 'Your logo',
      testimonials: [
        {
          quote:
            '“We went from chasing cold contacts to receiving opportunities ready to close. The change was immediate.”',
          author: 'First Last',
          role: 'Title · Company',
        },
        {
          quote:
            '“We finally have real visibility into our leads and what converts them. The team works with focus.”',
          author: 'First Last',
          role: 'Title · Company',
        },
      ],
      disclaimer: 'Sample metrics, logos and testimonials — editable before production.',
    },
    finalCta: {
      title: 'Ready to fill your pipeline with real opportunities?',
      subtitle: 'Turn interest into conversations with potential customers and free your team to focus on closing.',
      ctaPrimary: 'Get more leads',
      ctaSecondary: 'See how it works',
    },
    footer: {
      tagline: 'Leads and opportunities for businesses that want to grow.',
      columns: [
        {
          title: 'Site',
          links: [
            { label: 'Benefits', to: '/benefits' },
            { label: 'How it works', to: '/how-it-works' },
            { label: 'Industries', to: '/industries' },
            { label: 'Pricing', to: '/pricing' },
          ],
        },
        {
          title: 'Get started',
          links: [
            { label: 'Contact', to: '/contact' },
            { label: 'Events', to: '/events' },
          ],
        },
        {
          title: 'Legal',
          links: [
            { label: 'Privacy', to: '#' },
            { label: 'Terms', to: '#' },
            { label: 'Cookies', to: '#' },
          ],
        },
      ],
      rights: 'All rights reserved.',
    },
    pages: {
      benefits: {
        hero: {
          kicker: 'Benefits',
          title: 'More opportunities, less wasted time',
          titleEm: 'opportunities',
          subtitle:
            'A steady flow of relevant leads helps your business grow with less manual effort and more focus on closing.',
          ctaPrimary: 'Get more leads',
          ctaSecondary: 'See how it works',
          proof: 'More bookings, inquiries and sales from the interest that already exists.',
        },
        items: [
          {
            icon: 'chart',
            title: 'More sales opportunities',
            body: 'Keep a steady flow of prospects so your business never depends on a single channel.',
          },
          {
            icon: 'clock',
            title: 'Less time chasing customers',
            body: 'Stop manually chasing cold contacts and receive opportunities ready to reach out to.',
          },
          {
            icon: 'target',
            title: 'Prospects with intent',
            body: 'Reach people who already showed interest, not cold lists without context.',
          },
          {
            icon: 'bell',
            title: 'Better follow-up',
            body: 'Every lead arrives organized and with context so none goes cold or gets lost.',
          },
          {
            icon: 'bolt',
            title: 'A more efficient team',
            body: 'Your team spends its energy on conversations and closing, not repetitive prospecting.',
          },
          {
            icon: 'layers',
            title: 'More predictable growth',
            body: 'With an organized flow of opportunities it’s easier to plan and scale with confidence.',
          },
          {
            icon: 'sparkle',
            title: 'Fill your schedule',
            body: 'Generate more bookings, inquiries or sales by turning interest into real conversations.',
          },
          {
            icon: 'shield',
            title: 'Focus on closing',
            body: 'Your business focuses on actionable prospects instead of searching manually.',
          },
        ],
        cta: {
          title: 'Want more opportunities for your business?',
          subtitle: 'Let’s talk about how a steady flow of leads can help you grow.',
          primary: 'Talk to the team',
          secondary: 'See how it works',
        },
      },
      how: {
        hero: {
          kicker: 'How it works',
          title: 'From goal to customer, step by step',
          titleEm: 'customer',
          subtitle: 'A simple, transparent process to turn interest into actionable opportunities.',
          ctaPrimary: 'Start getting leads',
          ctaSecondary: 'See pricing',
          proof: 'A clear, transparent process built to scale with you.',
        },
        steps: [
          {
            n: '01',
            title: 'You define your goal',
            body: 'Tell us which customers you’re after and what outcome you want to achieve.',
          },
          {
            n: '02',
            title: 'We attract opportunities',
            body: 'We identify and capture people with real interest in what you offer.',
          },
          {
            n: '03',
            title: 'We organize the leads',
            body: 'Each prospect is sorted with context so it’s easy to prioritize.',
          },
          {
            n: '04',
            title: 'You receive actionable prospects',
            body: 'Your business gets leads ready to contact, with no manual prospecting.',
          },
          {
            n: '05',
            title: 'You follow up and convert',
            body: 'You focus on conversations and closing while the flow of opportunities continues.',
          },
        ],
        cta: {
          title: 'Ready to put the process to work?',
          subtitle: 'Start receiving actionable opportunities for your business.',
          primary: 'Start now',
          secondary: 'View pricing',
        },
      },
      industries: {
        hero: {
          kicker: 'Industries',
          title: 'Leads for many kinds of business',
          titleEm: 'Leads',
          subtitle:
            'If your business needs more customers, bookings or inquiries, a flow of relevant leads can help.',
          ctaPrimary: 'Get leads for my business',
          ctaSecondary: 'See the benefits',
          proof: 'Relevant leads matched to your kind of business.',
        },
        items: [
          {
            icon: 'calendar',
            title: 'Events',
            body: 'Fill seats and capture interested attendees for your upcoming events.',
          },
          {
            icon: 'briefcase',
            title: 'Professional services',
            body: 'Receive inquiries from clients looking for advisory, firms or specialized services.',
          },
          {
            icon: 'utensils',
            title: 'Restaurants & catering',
            body: 'Generate reservations and catering requests from customers in your area.',
          },
          {
            icon: 'heart',
            title: 'Health & wellness',
            body: 'Attract patients and clients looking to book appointments or wellness services.',
          },
          {
            icon: 'home',
            title: 'Real estate',
            body: 'Connect with people interested in buying, renting or selling properties.',
          },
          {
            icon: 'book',
            title: 'Education & courses',
            body: 'Capture students and prospects interested in your programs or courses.',
          },
          {
            icon: 'wrench',
            title: 'Local services',
            body: 'Receive requests from customers who need services in their area.',
          },
          {
            icon: 'building',
            title: 'B2B businesses',
            body: 'Generate commercial opportunities with other companies that need your solution.',
          },
        ],
        cta: {
          title: 'Don’t see your industry?',
          subtitle: 'The process adapts to most businesses that need more customers. Let’s talk.',
          primary: 'Talk to the team',
          secondary: 'See how it works',
        },
      },
      pricing: {
        hero: {
          kicker: 'Pricing',
          title: 'Plans built to grow with you',
          titleEm: 'grow with you',
          subtitle: 'Pick a starting point and scale as your business grows. Prices and terms are editable.',
          ctaPrimary: 'Talk to us',
          ctaSecondary: 'See how it works',
          proof: 'Simple plans that scale as your business grows.',
        },
        note: 'Prices shown are examples. Contact us for a quote tailored to your business.',
        plans: [
          {
            name: 'Starter',
            price: 'From ___',
            period: '/mo',
            description: 'For businesses starting to generate leads.',
            features: ['Initial lead flow', 'Basic organization', 'Email support'],
            cta: 'Get started',
          },
          {
            name: 'Growth',
            price: 'From ___',
            period: '/mo',
            description: 'For businesses that want to accelerate growth.',
            features: [
              'Higher lead volume',
              'Prospect prioritization',
              'Organized follow-up',
              'Priority support',
            ],
            cta: 'Get started',
            featured: true,
            badge: 'Most popular',
          },
          {
            name: 'Pro',
            price: 'Contact us',
            description: 'For teams with custom needs.',
            features: [
              'Custom volume',
              'Advanced integrations',
              'Dedicated guidance',
              'Custom reporting',
            ],
            cta: 'Contact us',
          },
        ],
        cta: {
          title: 'Not sure which plan to choose?',
          subtitle: 'Tell us your goal and we’ll help you find the ideal starting point.',
          primary: 'Talk to the team',
          secondary: 'See how it works',
        },
      },
      contact: {
        hero: {
          kicker: 'Contact',
          title: 'Let’s talk about getting more leads',
          titleEm: 'more leads',
          subtitle: 'Tell us about your business and your goal. We’ll reach out to help you get started.',
        },
        form: {
          name: 'Name',
          email: 'Email',
          business: 'Business name',
          industry: 'Industry',
          goal: 'Main goal',
          message: 'Message',
          namePlaceholder: 'Your name',
          emailPlaceholder: 'you@email.com',
          businessPlaceholder: 'Your business name',
          messagePlaceholder: 'Tell us what you want to achieve',
          industryDefault: 'Select an industry',
          goalDefault: 'Select a goal',
          industries: [
            'Events',
            'Professional services',
            'Restaurants & catering',
            'Health & wellness',
            'Real estate',
            'Education & courses',
            'Local services',
            'B2B businesses',
            'Other',
          ],
          goals: ['More bookings', 'More inquiries', 'More sales', 'More customers', 'Fill my schedule', 'Other'],
          submit: 'Send',
        },
        success: {
          title: 'Thanks for your interest!',
          body: 'This form is a demo: no data is sent to any server yet. Real submission is coming soon.',
          reset: 'Send another message',
        },
        alt: {
          text: 'Prefer to explore the app directly?',
          cta: 'Go to Events',
        },
        disclaimer: 'Demo form — not connected to a server yet.',
      },
    },
  },
};
