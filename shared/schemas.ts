import { z } from 'zod';

export const insuranceTypeSchema = z.enum(['HOUSE', 'AUTO', 'LIFE']);

export const registerSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  telefono: z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^[0-9+\-\s()]+$/, 'invalid_phone'),
  insuranceType: insuranceTypeSchema,
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
