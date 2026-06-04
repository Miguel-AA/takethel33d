export type InsuranceType = 'HOUSE' | 'AUTO' | 'LIFE';

export interface RegisterRequest {
  nombre: string;
  email: string;
  telefono: string;
  insuranceType: InsuranceType;
}

export interface RegisterResponse {
  id: string;
  participantNumber: number;
  createdAt: string;
}

export interface Attendee {
  id: string;
  participantNumber: number;
  nombre: string;
  email: string;
  telefono: string;
  insuranceType: InsuranceType;
  createdAt: string;
}

export interface AttendeeListResponse {
  items: Attendee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InsuranceTypeBreakdown {
  HOUSE: number;
  AUTO: number;
  LIFE: number;
}

export interface Metrics {
  total: number;
  leadsToday: number;
  byInsuranceType: InsuranceTypeBreakdown;
  insuranceTypePercent: InsuranceTypeBreakdown;
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

export interface RegistrationLookup {
  participantNumber: number;
  attendee: Attendee;
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
