import type {
  Attendee,
  AttendeeListResponse,
  CurrentRaffleResponse,
  EducationBreakdown,
  EducationLevel,
  HousingStatus,
  LoginResponse,
  Metrics,
  RaffleDrawRequest,
  RaffleDrawResponse,
  RegisterRequest,
  RegisterResponse,
} from '@shared/types';
import { EDUCATION_LEVELS } from '@shared/types';
import { ApiError } from './api';

const MOCK_PASSWORD = 'admin';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const educationLevels: EducationLevel[] = EDUCATION_LEVELS;
const housingStatuses: HousingStatus[] = ['OWNER', 'RENTER'];
const namesSeed: Array<[string, string]> = [
  ['Ana', 'López'],
  ['Carlos', 'Pérez'],
  ['María', 'García'],
  ['Juan', 'Rodríguez'],
  ['Lucía', 'Fernández'],
  ['Pedro', 'Sánchez'],
  ['Sofía', 'Ramírez'],
  ['Diego', 'Torres'],
  ['Valeria', 'Castro'],
  ['Andrés', 'Morales'],
  ['Camila', 'Vargas'],
  ['Mateo', 'Herrera'],
  ['Isabella', 'Ruiz'],
  ['Sebastián', 'Mendoza'],
  ['Daniela', 'Rojas'],
];

const attendees: Attendee[] = [];
let nextNumber = 1;
let currentWinner: CurrentRaffleResponse | null = null;
const drawnAttendeeIds = new Set<string>();
let activeToken: { token: string; expiresAt: string } | null = null;

function seed() {
  if (attendees.length > 0) return;
  const now = Date.now();
  namesSeed.forEach(([firstName, lastName], i) => {
    attendees.push({
      id: crypto.randomUUID(),
      participantNumber: nextNumber++,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}${i}@example.com`,
      phone: `+1 555 000 ${(1000 + i).toString().slice(-4)}`,
      highestLevelOfEducation: educationLevels[i % educationLevels.length],
      age: 22 + (i % 30),
      zip: `${33000 + i}`,
      city: 'Miami',
      housingStatus: housingStatuses[i % housingStatuses.length],
      ownsVehicle: i % 2 === 0,
      isBusinessOwner: i % 3 === 0,
      createdAt: new Date(now - (namesSeed.length - i) * 60_000).toISOString(),
    });
  });
}

function delay<T>(value: T, ms = 150): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function emptyEducation(): EducationBreakdown {
  return EDUCATION_LEVELS.reduce((acc, level) => {
    acc[level] = 0;
    return acc;
  }, {} as EducationBreakdown);
}

function computeMetrics(): Metrics {
  const total = attendees.length;
  const byHousingStatus = { OWNER: 0, RENTER: 0, unknown: 0 };
  const byVehicle = { yes: 0, no: 0, unknown: 0 };
  const byBusinessOwner = { yes: 0, no: 0, unknown: 0 };
  const byEducation = emptyEducation();

  for (const a of attendees) {
    if (a.housingStatus === 'OWNER' || a.housingStatus === 'RENTER') byHousingStatus[a.housingStatus]++;
    else byHousingStatus.unknown++;

    if (a.ownsVehicle === true) byVehicle.yes++;
    else if (a.ownsVehicle === false) byVehicle.no++;
    else byVehicle.unknown++;

    if (a.isBusinessOwner === true) byBusinessOwner.yes++;
    else if (a.isBusinessOwner === false) byBusinessOwner.no++;
    else byBusinessOwner.unknown++;

    if (a.highestLevelOfEducation) byEducation[a.highestLevelOfEducation]++;
  }

  const todayPrefix = new Date().toISOString().slice(0, 10);
  const leadsToday = attendees.filter((a) => a.createdAt.startsWith(todayPrefix)).length;
  return {
    total,
    leadsToday,
    byHousingStatus,
    byVehicle,
    byBusinessOwner,
    byEducation,
    updatedAt: new Date().toISOString(),
  };
}

function requireAuth() {
  if (!activeToken || new Date(activeToken.expiresAt).getTime() < Date.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Sesión expirada o no iniciada');
  }
}

export const mockApi = {
  async register(body: RegisterRequest): Promise<RegisterResponse> {
    seed();
    const emailLower = body.email.toLowerCase();
    if (attendees.some((a) => a.email.toLowerCase() === emailLower)) {
      throw new ApiError(409, 'EMAIL_EXISTS', 'Email ya registrado');
    }
    const attendee: Attendee = {
      id: crypto.randomUUID(),
      participantNumber: nextNumber++,
      firstName: body.firstName,
      lastName: body.lastName,
      email: emailLower,
      phone: body.phone,
      highestLevelOfEducation: body.highestLevelOfEducation,
      age: body.age,
      zip: body.zip,
      city: body.city,
      housingStatus: body.housingStatus,
      ownsVehicle: body.ownsVehicle,
      isBusinessOwner: body.isBusinessOwner,
      createdAt: new Date().toISOString(),
    };
    attendees.push(attendee);
    return delay({
      id: attendee.id,
      participantNumber: attendee.participantNumber,
      createdAt: attendee.createdAt,
    });
  },

  async login(password: string): Promise<LoginResponse> {
    if (password !== MOCK_PASSWORD) {
      throw new ApiError(401, 'INVALID_PASSWORD', 'Contraseña incorrecta');
    }
    activeToken = {
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    };
    return delay({ ...activeToken });
  },

  async me() {
    requireAuth();
    return delay({ ok: true as const });
  },

  async listAttendees(params: {
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AttendeeListResponse> {
    requireAuth();
    seed();
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));
    const search = (params.search ?? '').trim().toLowerCase();
    const filtered = search
      ? attendees.filter(
          (a) =>
            a.firstName.toLowerCase().includes(search) ||
            a.lastName.toLowerCase().includes(search) ||
            `${a.firstName} ${a.lastName}`.toLowerCase().includes(search) ||
            a.email.toLowerCase().includes(search) ||
            String(a.participantNumber).includes(search) ||
            String(a.participantNumber).padStart(3, '0').includes(search),
        )
      : attendees;
    const sorted = [...filtered].sort(
      (a, b) => b.participantNumber - a.participantNumber,
    );
    const start = (page - 1) * pageSize;
    return delay({
      items: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
      pageSize,
    });
  },

  async getAttendee(id: string): Promise<Attendee> {
    requireAuth();
    const found = attendees.find((a) => a.id === id);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'Lead no encontrado');
    return delay(found);
  },

  async metrics(): Promise<Metrics> {
    requireAuth();
    seed();
    return delay(computeMetrics());
  },

  async drawRaffle(body: RaffleDrawRequest): Promise<RaffleDrawResponse> {
    requireAuth();
    if (attendees.length === 0) {
      throw new ApiError(400, 'NO_ATTENDEES', 'No hay leads registrados');
    }
    let winner: Attendee;
    if (body.mode === 'manual') {
      const found = attendees.find(
        (a) => a.participantNumber === body.participantNumber,
      );
      if (!found) {
        throw new ApiError(
          404,
          'WINNER_NOT_FOUND',
          'Número de participante no encontrado',
        );
      }
      if (drawnAttendeeIds.has(found.id)) {
        throw new ApiError(
          409,
          'RAFFLE_ALREADY_DRAWN',
          'Ese participante ya fue seleccionado',
        );
      }
      winner = found;
    } else {
      const available = attendees.filter((a) => !drawnAttendeeIds.has(a.id));
      if (available.length === 0) {
        throw new ApiError(
          409,
          'RAFFLE_ALREADY_DRAWN',
          'Todos los participantes ya fueron sorteados',
        );
      }
      winner = available[Math.floor(Math.random() * available.length)];
    }
    drawnAttendeeIds.add(winner.id);
    const drawnAt = new Date().toISOString();
    currentWinner = { winner, drawnAt };
    return delay({ winner, drawnAt, emailSent: true });
  },

  async currentRaffle(): Promise<CurrentRaffleResponse | null> {
    requireAuth();
    return delay(currentWinner);
  },
};
