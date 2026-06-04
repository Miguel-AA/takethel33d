import { registerSchema } from '@shared/schemas';
import type { InsuranceType, RegisterRequest } from '@shared/types';

/**
 * Field aliases used to find each form field inside Jotform's `rawRequest`
 * JSON payload. Jotform keys are typically `q{N}_{slug}` — we strip the
 * `qN_` prefix and match the remaining slug against these aliases, so the
 * mapping works no matter which slot number Jotform assigned to the field.
 */
export const FIELD_ALIASES = {
  nombre: ['name', 'fullName', 'nombreCompleto', 'nombre'],
  email: ['email', 'correoElectronico', 'correo', 'emailAddress'],
  telefono: ['number', 'phoneNumber', 'phone', 'telephoneNumber', 'telefono'],
  insuranceType: [
    'whatTypeOfInsuranceAreYouInterestedIn',
    'whatTypeOfInsurance',
    'typeOfInsurance',
    'insuranceType',
    'insurance',
    'tipoDeSeguro',
    'tipoSeguro',
  ],
} satisfies Record<keyof RegisterRequest, string[]>;

/**
 * Maps the human-readable option text Jotform sends to our schema enums.
 * Covers ES/EN labels for House/Auto/Life.
 */
export const INSURANCE_TYPE_MAP: Record<string, InsuranceType> = {
  House: 'HOUSE',
  house: 'HOUSE',
  Home: 'HOUSE',
  Casa: 'HOUSE',
  Hogar: 'HOUSE',
  'Seguro de casa': 'HOUSE',
  'Seguro de hogar': 'HOUSE',

  Auto: 'AUTO',
  auto: 'AUTO',
  Car: 'AUTO',
  Vehículo: 'AUTO',
  Coche: 'AUTO',
  'Seguro de auto': 'AUTO',
  'Seguro de coche': 'AUTO',

  Life: 'LIFE',
  life: 'LIFE',
  Vida: 'LIFE',
  'Seguro de vida': 'LIFE',
};

export interface ParsedJotformPayload {
  submissionId: string;
  formId: string;
  data: RegisterRequest;
}

export class JotformParseError extends Error {
  code:
    | 'MISSING_SUBMISSION_ID'
    | 'MISSING_RAW_REQUEST'
    | 'BAD_RAW_REQUEST'
    | 'MISSING_FIELD'
    | 'BAD_OPTION'
    | 'VALIDATION';
  details?: unknown;
  constructor(code: JotformParseError['code'], message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function extractString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const collapsed = value
      .filter((x) => typeof x === 'string')
      .map((s) => (s as string).trim())
      .filter((s) => s.length > 0)
      .join(', ');
    return collapsed.length > 0 ? collapsed : undefined;
  }
  if (value && typeof value === 'object') {
    // Jotform compound fields, e.g. name: { first, last, prefix, suffix }
    // or phone: { full } / { area, phone }.
    const obj = value as Record<string, unknown>;
    if (typeof obj.full === 'string' && obj.full.trim().length > 0) {
      return obj.full.trim();
    }
    const collapsed = Object.values(obj)
      .filter((x) => typeof x === 'string')
      .map((s) => (s as string).trim())
      .filter((s) => s.length > 0)
      .join(' ');
    return collapsed.length > 0 ? collapsed : undefined;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
}

function findValue(
  raw: Record<string, unknown>,
  aliases: string[],
): string | undefined {
  // Normalize each key once: strip the leading qN_ that Jotform prepends.
  const normalized = Object.keys(raw).map((key) => ({
    key,
    slug: key.replace(/^q\d+_/i, '').toLowerCase(),
  }));
  // Exact-slug match first.
  for (const alias of aliases) {
    const a = alias.toLowerCase();
    const exact = normalized.find((n) => n.slug === a);
    if (exact) {
      const s = extractString(raw[exact.key]);
      if (s) return s;
    }
  }
  // Substring fallback (e.g. alias "email" finds "emailAddress").
  for (const alias of aliases) {
    const a = alias.toLowerCase();
    const partial = normalized.find((n) => n.slug.includes(a));
    if (partial) {
      const s = extractString(raw[partial.key]);
      if (s) return s;
    }
  }
  return undefined;
}

function lookupEnum<T extends string>(
  map: Record<string, T>,
  raw: string | undefined,
): T | undefined {
  if (!raw) return undefined;
  if (map[raw]) return map[raw];
  const lower = raw.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Parses a Jotform webhook payload (multipart/form-data) into a validated
 * `RegisterRequest`. Throws `JotformParseError` on any failure so the
 * webhook handler can log it and return 200 (no Jotform retry loop).
 */
export function parseJotformPayload(form: FormData): ParsedJotformPayload {
  const submissionId = form.get('submissionID');
  if (typeof submissionId !== 'string' || submissionId.length === 0) {
    throw new JotformParseError('MISSING_SUBMISSION_ID', 'submissionID missing');
  }
  const formId = (form.get('formID') as string | null) ?? '';

  const rawRequestStr = form.get('rawRequest');
  if (typeof rawRequestStr !== 'string' || rawRequestStr.length === 0) {
    throw new JotformParseError('MISSING_RAW_REQUEST', 'rawRequest missing');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawRequestStr) as Record<string, unknown>;
  } catch (err) {
    throw new JotformParseError('BAD_RAW_REQUEST', 'rawRequest is not JSON', err);
  }

  const candidate = {
    nombre: findValue(raw, FIELD_ALIASES.nombre),
    email: findValue(raw, FIELD_ALIASES.email),
    telefono: findValue(raw, FIELD_ALIASES.telefono),
    insuranceType: lookupEnum(
      INSURANCE_TYPE_MAP,
      findValue(raw, FIELD_ALIASES.insuranceType),
    ),
  };

  const parsed = registerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new JotformParseError(
      'VALIDATION',
      'Jotform payload failed validation',
      { issues: parsed.error.issues, rawKeys: Object.keys(raw) },
    );
  }

  return { submissionId, formId, data: parsed.data };
}

export function isAllowedFormId(
  formId: string,
  csv: string | undefined,
  options: { requireConfigured?: boolean } = {},
): boolean {
  if (!csv) return options.requireConfigured ? false : true;
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .includes(formId);
}
