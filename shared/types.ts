// Housing status collected on the /events lead form.
export type HousingStatus = 'OWNER' | 'RENTER';

// Highest level of education collected on the /events lead form.
export type EducationLevel =
  | 'HIGH_SCHOOL'
  | 'SOME_COLLEGE'
  | 'ASSOCIATE'
  | 'BACHELORS'
  | 'MASTERS'
  | 'DOCTORATE'
  | 'OTHER';

export const EDUCATION_LEVELS: EducationLevel[] = [
  'HIGH_SCHOOL',
  'SOME_COLLEGE',
  'ASSOCIATE',
  'BACHELORS',
  'MASTERS',
  'DOCTORATE',
  'OTHER',
];

export const HOUSING_STATUSES: HousingStatus[] = ['OWNER', 'RENTER'];

// Payload submitted by the /events data-collection form. All fields here are
// required for a NEW submission (the multi-step form validates each one).
export interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  highestLevelOfEducation: EducationLevel;
  age: number;
  zip: string;
  // City may be auto-populated from the zip; it is optional and never blocks
  // submission if it could not be resolved.
  city?: string;
  housingStatus: HousingStatus;
  ownsVehicle: boolean;
  isBusinessOwner: boolean;
}

export interface RegisterResponse {
  id: string;
  participantNumber: number;
  createdAt: string;
}

// A stored lead. The survey fields are optional here (not on RegisterRequest)
// so legacy/imported rows that pre-date these columns still read cleanly.
export interface Attendee {
  id: string;
  participantNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  highestLevelOfEducation?: EducationLevel;
  age?: number;
  zip?: string;
  city?: string;
  housingStatus?: HousingStatus;
  ownsVehicle?: boolean;
  isBusinessOwner?: boolean;
  createdAt: string;
}

export interface AttendeeListResponse {
  items: Attendee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface YesNoBreakdown {
  yes: number;
  no: number;
  unknown: number;
}

export interface HousingBreakdown {
  OWNER: number;
  RENTER: number;
  unknown: number;
}

export type EducationBreakdown = Record<EducationLevel, number>;

export interface Metrics {
  total: number;
  leadsToday: number;
  byHousingStatus: HousingBreakdown;
  byVehicle: YesNoBreakdown;
  byBusinessOwner: YesNoBreakdown;
  byEducation: EducationBreakdown;
  updatedAt: string;
}

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
}

export type RaffleDrawRequest =
  | { mode: 'random' }
  | { mode: 'manual'; participantNumber: number };

export interface RaffleDrawResponse {
  winner: Attendee;
  drawnAt: string;
  emailSent: boolean;
}

export interface CurrentRaffleResponse {
  winner: Attendee;
  drawnAt: string;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'EMAIL_EXISTS'
  | 'INVALID_PASSWORD'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'WINNER_NOT_FOUND'
  | 'NO_ATTENDEES'
  | 'RAFFLE_ALREADY_DRAWN'
  | 'RATE_LIMIT'
  | 'PENDING'
  | 'SERVER_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string>;
  };
}
