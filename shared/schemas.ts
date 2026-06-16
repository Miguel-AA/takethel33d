import { z } from 'zod';

export const housingStatusSchema = z.enum(['OWNER', 'RENTER']);

export const educationLevelSchema = z.enum([
  'HIGH_SCHOOL',
  'SOME_COLLEGE',
  'ASSOCIATE',
  'BACHELORS',
  'MASTERS',
  'DOCTORATE',
  'OTHER',
]);

// Accepts a real boolean (JSON API clients) or the "true"/"false" strings that
// HTML radio inputs produce, so the same schema validates both transports.
const booleanFromForm = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

export const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(160),
  phone: z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^[0-9+\-\s()]+$/, 'invalid_phone'),
  highestLevelOfEducation: educationLevelSchema,
  age: z.coerce.number().int().min(16).max(120),
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, 'invalid_zip'),
  city: z.string().trim().max(120).optional(),
  housingStatus: housingStatusSchema,
  ownsVehicle: booleanFromForm,
  isBusinessOwner: booleanFromForm,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  password: z.string().min(1).max(200),
});

export const raffleDrawSchema = z.union([
  z.object({ mode: z.literal('random') }),
  z.object({
    mode: z.literal('manual'),
    participantNumber: z.coerce.number().int().positive(),
  }),
]);
