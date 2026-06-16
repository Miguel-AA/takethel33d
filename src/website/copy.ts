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
  about: string;
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
  /** Royal-blue primary button label (-> /events). */
  ctaPrimary: string;
  /** Light-blue secondary button label (-> /how-it-works). */
  ctaSecondary: string;
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
/** Honest, non-fake bridge into a future Google Reviews integration. */
interface ReviewsBridge {
  title: string;
  subtitle: string;
  note: string;
  cta: string;
}
interface StatsCopy {
  kicker: string;
  title: string;
  subtitle: string;
  metrics: Metric[];
  reviews: ReviewsBridge;
  disclaimer: string;
}
interface WhoWeAreCopy {
  kicker: string;
  title: string;
  subtitle: string;
  ceoHeading: string;
  ceoName: string;
  ceoRole: string;
  /** CEO bio paragraphs, kept verbatim. */
  ceoParagraphs: string[];
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
/** A heading + up to 3 icon cards. */
interface CardSection {
  kicker: string;
  title: string;
  subtitle?: string;
  items: IconItem[];
}
/** A heading + up to 3 numbered steps. */
interface StepSection {
  kicker: string;
  title: string;
  subtitle?: string;
  steps: Step[];
}
interface BenefitsPageCopy {
  hero: PageHero;
  core: CardSection;
  why: CardSection;
  cta: CtaBand;
}
interface HowPageCopy {
  hero: PageHero;
  process: StepSection;
  different: CardSection;
  cta: CtaBand;
}
interface IndustriesPageCopy {
  hero: PageHero;
  industries: CardSection;
  adapt: CardSection;
  cta: CtaBand;
}
interface AboutPageCopy {
  hero: PageHero;
  team: { heading: string; body: string };
  values: CardSection;
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
  about: AboutPageCopy;
  pricing: PricingPageCopy;
  contact: ContactPageCopy;
}

export interface LandingCopy {
  nav: NavCopy;
  hero: HeroCopy;
  benefits: BenefitsCopy;
  how: HowCopy;
  features: FeaturesCopy;
  stats: StatsCopy;
  whoWeAre: WhoWeAreCopy;
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
      about: 'Nosotros',
      pricing: 'Planes',
      contact: 'Contacto',
      events: 'Events',
      getLeads: 'Quiero más leads',
      menu: 'Menú',
    },
    hero: {
      badge: 'Leads y oportunidades para negocios',
      titleStart: 'Driving Business Growth through',
      titleEm: 'Quality Leads.',
      titleEnd: '',
      subtitle:
        'Te entregamos un flujo organizado de leads con intención para que tu equipo dedique su tiempo a cerrar, no a buscar contactos en frío.',
      ctaPrimary: 'Quiero más leads',
      ctaSecondary: 'Ver cómo funciona',
      proof: 'Más reservas, consultas y ventas a partir del interés que ya existe.',
      mockup: {
        label: 'L33D Pipeline',
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
      title: 'New Business. Consistent Growth. Zero Wasted Time.',
      subtitle:
        'Stop chasing cold prospects. Get a reliable pipeline of relevant leads and grow on your terms.',
      ctaPrimary: 'TAKE THE L33D',
      ctaSecondary: 'Cómo funciona',
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
          icon: 'chart',
          title: 'Crecimiento más predecible',
          body: 'Un flujo constante de oportunidades hace más fácil planear y escalar con confianza.',
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
    stats: {
      kicker: 'L33D Stats',
      title: 'Negocios que crecen con datos, no con suposiciones',
      subtitle: 'Una muestra del impacto que un flujo constante de leads puede generar.',
      metrics: [
        { value: '10k+', label: 'Leads procesados' },
        { value: '34%', label: 'Tasa accionable' },
        { value: '<24h', label: 'Tiempo de respuesta' },
        { value: '99.9%', label: 'Disponibilidad' },
      ],
      reviews: {
        title: 'Lo que dicen nuestros clientes',
        subtitle: 'Pronto verás aquí nuestras reseñas verificadas de Google.',
        note: 'Las reseñas aparecerán en cuanto conectemos nuestro perfil de Google Business.',
        cta: 'Verifícanos en Google',
      },
      disclaimer: 'Métricas de ejemplo — actualízalas con datos reales antes de producción.',
    },
    whoWeAre: {
      kicker: 'Quiénes somos',
      title: 'Construido por gente que ha vivido el proceso de ventas',
      subtitle: 'Conoce a la persona detrás de TAKE THE L33D.',
      ceoHeading: 'About our CEO',
      ceoName: 'Onelio Rios',
      ceoRole: 'Fundador y CEO',
      ceoParagraphs: [
        'Onelio Rios founded TAKE THE L33D with one goal — helping businesses grow through smarter, more consistent lead generation.',
        'His background in B2B sales, where he was recognized as a top 4 sales representative in the country, combined with hands-on experience managing client accounts in the insurance industry, gives him a firsthand understanding of what businesses need to grow. He knows the value of a reliable lead pipeline because he’s depended on one.',
        'Onelio holds a Business degree from the University of West Florida and a Master’s in Human Resource Management from Delta State University. During graduate school, he competed at the national level with the Future Business Leaders of America Organization in Business Presentation and Job Interview.',
        'At TAKE THE L33D, we’ve lived the sales process — and built a company to make it easier, faster, and more profitable for businesses like yours.',
      ],
    },
    finalCta: {
      title: '¿Listo para llenar tu agenda con oportunidades reales?',
      subtitle: 'Convierte el interés en conversaciones con clientes potenciales y enfoca a tu equipo en cerrar.',
      ctaPrimary: 'Quiero más leads',
      ctaSecondary: 'Ver cómo funciona',
    },
    footer: {
      tagline: 'Driving Business Growth through Quality Leads.',
      columns: [
        {
          title: 'Sitio',
          links: [
            { label: 'Beneficios', to: '/benefits' },
            { label: 'Cómo funciona', to: '/how-it-works' },
            { label: 'Industrias', to: '/industries' },
            { label: 'Nosotros', to: '/about-us' },
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
          title: 'New Business. Consistent Growth. Zero Wasted Time.',
          titleEm: 'Consistent Growth.',
          subtitle:
            'Stop chasing cold prospects. Get a reliable pipeline of relevant leads and grow on your terms.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'Cómo funciona',
          proof: 'Más reservas, consultas y ventas a partir del interés que ya existe.',
        },
        core: {
          kicker: 'Beneficios principales',
          title: 'Tres razones por las que los negocios crecen con nosotros',
          subtitle: 'Menos ruido, más oportunidades reales y tiempo de vuelta para tu equipo.',
          items: [
            {
              icon: 'target',
              title: 'Leads de calidad, no ruido',
              body: 'Llega a personas que ya muestran intención para que tu equipo hable con prospectos que valen la pena.',
            },
            {
              icon: 'chart',
              title: 'Un pipeline constante',
              body: 'Un flujo predecible de oportunidades mes a mes, sin altibajos.',
            },
            {
              icon: 'clock',
              title: 'Menos tiempo perdido',
              body: 'Deja de perseguir contactos en frío y enfoca tus horas en cerrar.',
            },
          ],
        },
        why: {
          kicker: 'Por qué importa',
          title: 'El impacto real en tu negocio',
          subtitle: 'Un pipeline confiable cambia la forma en que planeas y creces.',
          items: [
            {
              icon: 'sparkle',
              title: 'Ingresos predecibles',
              body: 'Cuando las oportunidades llegan de forma constante, el crecimiento se vuelve algo que puedes planear.',
            },
            {
              icon: 'bolt',
              title: 'Respuesta más rápida',
              body: 'Leads organizados y listos para contactar te permiten responder mientras el interés está caliente.',
            },
            {
              icon: 'shield',
              title: 'Confianza para escalar',
              body: 'Un pipeline confiable te permite invertir en tu equipo y crecer sin adivinar.',
            },
          ],
        },
        cta: {
          title: '¿Listo para tomar la iniciativa?',
          subtitle: 'Convierte el interés en conversaciones reales y crece en tus términos.',
          primary: 'TAKE THE L33D',
          secondary: 'Ver cómo funciona',
        },
      },
      how: {
        hero: {
          kicker: 'Cómo funciona',
          title: 'De objetivo a cliente, paso a paso',
          titleEm: 'paso a paso',
          subtitle: 'Un proceso simple y transparente que convierte el interés en oportunidades calificadas.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'Ver planes',
          proof: 'Un proceso claro, transparente y diseñado para escalar contigo.',
        },
        process: {
          kicker: 'El proceso',
          title: 'Tres pasos simples',
          subtitle: 'Una historia clara, sin complicaciones.',
          steps: [
            {
              n: '01',
              title: 'Entendemos a tu cliente ideal',
              body: 'Empezamos por conocer a quién quieres llegar y cómo es un buen lead para ti.',
            },
            {
              n: '02',
              title: 'Construimos y entregamos un pipeline calificado',
              body: 'Identificamos y captamos personas con intención real y te las entregamos organizadas y listas.',
            },
            {
              n: '03',
              title: 'Tú te enfocas en cerrar y crecer',
              body: 'Tu equipo dedica su tiempo a conversaciones que convierten, no a buscar prospectos.',
            },
          ],
        },
        different: {
          kicker: 'Qué lo hace diferente',
          title: 'No es volumen por volumen',
          subtitle: 'Targeting más inteligente, entrega constante y menos tiempo perdido.',
          items: [
            {
              icon: 'target',
              title: 'Targeting más inteligente',
              body: 'Nos enfocamos en intención y encaje, no en volumen porque sí.',
            },
            {
              icon: 'layers',
              title: 'Entrega constante',
              body: 'Una cadencia estable de oportunidades con la que puedes contar.',
            },
            {
              icon: 'clock',
              title: 'Menos tiempo perdido',
              body: 'Se acabaron las listas frías: cada lead llega con contexto.',
            },
          ],
        },
        cta: {
          title: '¿Listo para poner el proceso a trabajar?',
          subtitle: 'Empieza a recibir oportunidades calificadas para tu negocio.',
          primary: 'TAKE THE L33D',
          secondary: 'Ver beneficios',
        },
      },
      industries: {
        hero: {
          kicker: 'Industrias',
          title: 'Hecho para negocios que dependen de un pipeline constante',
          titleEm: 'pipeline constante',
          subtitle:
            'Si tu crecimiento depende de un flujo confiable de oportunidades calificadas, TAKE THE L33D puede ayudar.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'Ver cómo funciona',
          proof: 'Leads relevantes para tu tipo de negocio.',
        },
        industries: {
          kicker: 'Industrias que apoyamos',
          title: 'Categorías donde marcamos la diferencia',
          subtitle: 'Si tu negocio necesita un flujo constante de clientes, encajas aquí.',
          items: [
            {
              icon: 'shield',
              title: 'Seguros y servicios financieros',
              body: 'Conecta con personas que buscan activamente cobertura, planeación y protección.',
            },
            {
              icon: 'home',
              title: 'Servicios para el hogar y negocios locales',
              body: 'Llega a clientes cercanos que necesitan tu servicio justo cuando lo necesitan.',
            },
            {
              icon: 'briefcase',
              title: 'Servicios profesionales y B2B',
              body: 'Genera conversaciones calificadas con los negocios y clientes que quieres.',
            },
          ],
        },
        adapt: {
          kicker: 'Cómo nos adaptamos',
          title: 'La estrategia se ajusta a tu realidad',
          subtitle: 'El mercado, la ubicación y el tipo de cliente moldean cada estrategia de leads.',
          items: [
            {
              icon: 'target',
              title: 'Por mercado',
              body: 'Estrategia de leads ajustada a la demanda y la competencia de tu sector.',
            },
            {
              icon: 'home',
              title: 'Por ubicación',
              body: 'Nos enfocamos en las regiones y zonas que importan para tu negocio.',
            },
            {
              icon: 'funnel',
              title: 'Por tipo de cliente',
              body: 'Targeting diseñado en torno al cliente exacto que quieres alcanzar.',
            },
          ],
        },
        cta: {
          title: '¿No ves tu industria exacta?',
          subtitle: 'El proceso se adapta a la mayoría de negocios que necesitan más oportunidades calificadas. Hablemos.',
          primary: 'TAKE THE L33D',
          secondary: 'Hablar con el equipo',
        },
      },
      about: {
        hero: {
          kicker: 'About Us',
          title: 'Hacer que el crecimiento sea predecible',
          titleEm: 'predecible',
          subtitle:
            'TAKE THE L33D nació para que los negocios dejen de adivinar de dónde vendrá su próxima oportunidad. Ayudamos a las empresas a crear un camino más confiable hacia el crecimiento con generación de leads más inteligente, pipelines más sólidos y un proceso diseñado para la acción.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'Ver cómo funciona',
          proof: 'Crecimiento más inteligente a través de leads de calidad.',
        },
        team: {
          heading: 'Sobre el equipo de TAKE THE L33D',
          body: 'Nuestro equipo combina estrategia con mentalidad de ventas, ejecución centrada en el cliente y un entendimiento práctico de lo que un negocio necesita de un pipeline de leads. Nos enfocamos en ayudar a los dueños de negocio a perder menos tiempo persiguiendo contactos en frío y dedicar más tiempo a conectar con oportunidades reales.',
        },
        values: {
          kicker: 'En qué creemos',
          title: 'Los valores que guían nuestro trabajo',
          items: [
            {
              icon: 'chart',
              title: 'Crecimiento más inteligente',
              body: 'Estrategia y targeting por encima de adivinar y del volumen por el volumen.',
            },
            {
              icon: 'layers',
              title: 'Pipeline constante',
              body: 'Un flujo estable y predecible de oportunidades reales.',
            },
            {
              icon: 'clock',
              title: 'Menos tiempo perdido',
              body: 'Más tiempo cerrando, menos tiempo persiguiendo leads fríos.',
            },
          ],
        },
        cta: {
          title: '¿Listo para tomar la iniciativa?',
          subtitle: 'Conecta con oportunidades reales y crece en tus términos.',
          primary: 'TAKE THE L33D',
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
      about: 'About Us',
      pricing: 'Pricing',
      contact: 'Contact',
      events: 'Events',
      getLeads: 'Get more leads',
      menu: 'Menu',
    },
    hero: {
      badge: 'Leads and opportunities for businesses',
      titleStart: 'Driving Business Growth through',
      titleEm: 'Quality Leads.',
      titleEnd: '',
      subtitle:
        'We deliver an organized flow of intent-driven leads so your team spends its time closing deals, not chasing cold contacts.',
      ctaPrimary: 'Get more leads',
      ctaSecondary: 'See how it works',
      proof: 'More bookings, inquiries and sales from the interest that already exists.',
      mockup: {
        label: 'L33D Pipeline',
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
      title: 'New Business. Consistent Growth. Zero Wasted Time.',
      subtitle:
        'Stop chasing cold prospects. Get a reliable pipeline of relevant leads and grow on your terms.',
      ctaPrimary: 'TAKE THE L33D',
      ctaSecondary: 'How it works',
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
          icon: 'chart',
          title: 'More predictable growth',
          body: 'A steady flow of opportunities makes it easier to plan and scale with confidence.',
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
    stats: {
      kicker: 'L33D Stats',
      title: 'Businesses that grow with data, not guesswork',
      subtitle: 'A snapshot of the impact a steady flow of leads can create.',
      metrics: [
        { value: '10k+', label: 'Leads processed' },
        { value: '34%', label: 'Actionable rate' },
        { value: '<24h', label: 'Response time' },
        { value: '99.9%', label: 'Uptime' },
      ],
      reviews: {
        title: 'What our clients say',
        subtitle: 'Verified Google reviews are coming here soon.',
        note: 'Reviews will appear once we connect our Google Business profile.',
        cta: 'Find us on Google',
      },
      disclaimer: 'Sample metrics — replace with real numbers before production.',
    },
    whoWeAre: {
      kicker: 'Who we are',
      title: 'Built by people who have lived the sales process',
      subtitle: 'Meet the person behind TAKE THE L33D.',
      ceoHeading: 'About our CEO',
      ceoName: 'Onelio Rios',
      ceoRole: 'Founder & CEO',
      ceoParagraphs: [
        'Onelio Rios founded TAKE THE L33D with one goal — helping businesses grow through smarter, more consistent lead generation.',
        'His background in B2B sales, where he was recognized as a top 4 sales representative in the country, combined with hands-on experience managing client accounts in the insurance industry, gives him a firsthand understanding of what businesses need to grow. He knows the value of a reliable lead pipeline because he’s depended on one.',
        'Onelio holds a Business degree from the University of West Florida and a Master’s in Human Resource Management from Delta State University. During graduate school, he competed at the national level with the Future Business Leaders of America Organization in Business Presentation and Job Interview.',
        'At TAKE THE L33D, we’ve lived the sales process — and built a company to make it easier, faster, and more profitable for businesses like yours.',
      ],
    },
    finalCta: {
      title: 'Ready to fill your pipeline with real opportunities?',
      subtitle: 'Turn interest into conversations with potential customers and free your team to focus on closing.',
      ctaPrimary: 'Get more leads',
      ctaSecondary: 'See how it works',
    },
    footer: {
      tagline: 'Driving Business Growth through Quality Leads.',
      columns: [
        {
          title: 'Site',
          links: [
            { label: 'Benefits', to: '/benefits' },
            { label: 'How it works', to: '/how-it-works' },
            { label: 'Industries', to: '/industries' },
            { label: 'About Us', to: '/about-us' },
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
          title: 'New Business. Consistent Growth. Zero Wasted Time.',
          titleEm: 'Consistent Growth.',
          subtitle:
            'Stop chasing cold prospects. Get a reliable pipeline of relevant leads and grow on your terms.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'How it works',
          proof: 'More bookings, inquiries and sales from the interest that already exists.',
        },
        core: {
          kicker: 'Core benefits',
          title: 'Three reasons businesses grow with us',
          subtitle: 'Less noise, more real opportunities, and time given back to your team.',
          items: [
            {
              icon: 'target',
              title: 'Quality leads, not noise',
              body: 'Reach people already showing intent so your team talks to prospects worth their time.',
            },
            {
              icon: 'chart',
              title: 'A consistent pipeline',
              body: 'A steady, predictable flow of opportunities month after month — no feast or famine.',
            },
            {
              icon: 'clock',
              title: 'Less wasted time',
              body: 'Stop manually chasing cold contacts and focus your hours on closing.',
            },
          ],
        },
        why: {
          kicker: 'Why it matters',
          title: 'The real impact on your business',
          subtitle: 'A reliable pipeline changes how you plan and how you grow.',
          items: [
            {
              icon: 'sparkle',
              title: 'Predictable revenue',
              body: 'When opportunities arrive consistently, growth becomes something you can plan for.',
            },
            {
              icon: 'bolt',
              title: 'Faster response',
              body: 'Organized, ready-to-contact leads mean you reach people while interest is hot.',
            },
            {
              icon: 'shield',
              title: 'Confidence to scale',
              body: 'A reliable pipeline lets you invest in your team and grow without guessing.',
            },
          ],
        },
        cta: {
          title: 'Ready to take the lead?',
          subtitle: 'Turn interest into real conversations and grow on your terms.',
          primary: 'TAKE THE L33D',
          secondary: 'See how it works',
        },
      },
      how: {
        hero: {
          kicker: 'How it works',
          title: 'From goal to customer, step by step',
          titleEm: 'step by step',
          subtitle: 'A simple, transparent process that turns interest into qualified opportunities.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'See pricing',
          proof: 'A clear, transparent process built to scale with you.',
        },
        process: {
          kicker: 'The process',
          title: 'Three simple steps',
          subtitle: 'Clear, step-by-step storytelling — no guesswork.',
          steps: [
            {
              n: '01',
              title: 'We understand your target customer',
              body: 'We start by learning who you want to reach and what a great lead looks like for you.',
            },
            {
              n: '02',
              title: 'We build and deliver a qualified pipeline',
              body: 'We identify and capture people with real intent and hand them to you organized and ready.',
            },
            {
              n: '03',
              title: 'You focus on closing and growing',
              body: 'Your team spends its time on conversations that convert, not on prospecting.',
            },
          ],
        },
        different: {
          kicker: 'What makes it different',
          title: 'Not volume for volume’s sake',
          subtitle: 'Smarter targeting, consistent delivery, and less wasted time.',
          items: [
            {
              icon: 'target',
              title: 'Smarter targeting',
              body: 'We focus on intent and fit, not volume for volume’s sake.',
            },
            {
              icon: 'layers',
              title: 'Consistent delivery',
              body: 'A steady cadence of opportunities you can count on.',
            },
            {
              icon: 'clock',
              title: 'Less wasted time',
              body: 'No more chasing cold lists — every lead arrives with context.',
            },
          ],
        },
        cta: {
          title: 'Ready to put the process to work?',
          subtitle: 'Start receiving qualified opportunities for your business.',
          primary: 'TAKE THE L33D',
          secondary: 'See the benefits',
        },
      },
      industries: {
        hero: {
          kicker: 'Industries',
          title: 'Built for businesses that run on a steady pipeline',
          titleEm: 'steady pipeline',
          subtitle:
            'If your growth depends on a reliable flow of qualified opportunities, TAKE THE L33D can help.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'See how it works',
          proof: 'Relevant leads matched to your kind of business.',
        },
        industries: {
          kicker: 'Industries we support',
          title: 'Categories where we make a difference',
          subtitle: 'If your business needs a steady flow of customers, you fit right in.',
          items: [
            {
              icon: 'shield',
              title: 'Insurance & Financial Services',
              body: 'Connect with people actively looking for coverage, planning, and protection.',
            },
            {
              icon: 'home',
              title: 'Home Services & Local Businesses',
              body: 'Reach nearby customers who need your service right when they need it.',
            },
            {
              icon: 'briefcase',
              title: 'Professional & B2B Services',
              body: 'Generate qualified conversations with the businesses and clients you want.',
            },
          ],
        },
        adapt: {
          kicker: 'How we adapt',
          title: 'Strategy that fits your reality',
          subtitle: 'Market, location, and customer type shape every lead strategy.',
          items: [
            {
              icon: 'target',
              title: 'By market',
              body: 'Lead strategy tuned to the demand and competition in your space.',
            },
            {
              icon: 'home',
              title: 'By location',
              body: 'We focus on the regions and neighborhoods that matter to your business.',
            },
            {
              icon: 'funnel',
              title: 'By customer type',
              body: 'Targeting shaped around the exact customer you’re trying to reach.',
            },
          ],
        },
        cta: {
          title: 'Don’t see your exact industry?',
          subtitle: 'The process adapts to most businesses that need more qualified opportunities. Let’s talk.',
          primary: 'TAKE THE L33D',
          secondary: 'Talk to the team',
        },
      },
      about: {
        hero: {
          kicker: 'About Us',
          title: 'Making growth predictable',
          titleEm: 'predictable',
          subtitle:
            'TAKE THE L33D was built to help businesses stop guessing where their next opportunity will come from. We help companies create a more reliable path to growth through smarter lead generation, stronger pipelines, and a process designed around action.',
          ctaPrimary: 'TAKE THE L33D',
          ctaSecondary: 'See how it works',
          proof: 'Smarter growth through quality leads.',
        },
        team: {
          heading: 'About the TAKE THE L33D team',
          body: 'Our team brings together sales-minded strategy, client-focused execution, and a practical understanding of what businesses need from a lead pipeline. We focus on helping business owners spend less time chasing cold prospects and more time connecting with real opportunities.',
        },
        values: {
          kicker: 'What we believe',
          title: 'The values that drive our work',
          items: [
            {
              icon: 'chart',
              title: 'Smarter Growth',
              body: 'Strategy and targeting over guesswork and volume.',
            },
            {
              icon: 'layers',
              title: 'Consistent Pipeline',
              body: 'A steady, predictable flow of real opportunities.',
            },
            {
              icon: 'clock',
              title: 'Less Wasted Time',
              body: 'More time closing, less time chasing cold leads.',
            },
          ],
        },
        cta: {
          title: 'Ready to take the lead?',
          subtitle: 'Connect with real opportunities and grow on your terms.',
          primary: 'TAKE THE L33D',
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
