import { z } from 'zod';

export const roles = ['organizer', 'judge', 'participant'] as const;
export const RoleSchema = z.enum(roles);
export type Role = (typeof roles)[number];

const IdentitySchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  role: z.enum(roles),
  teamId: z.string().nullable().optional(),
});

export const OrganizationStatusSchema = z.discriminatedUnion('authenticated', [
  z.object({
    organization: z.string().nullable().optional(),
    authenticated: z.literal(false),
  }),
  z
    .object({
      organization: z.string().nullable().optional(),
      authenticated: z.literal(true),
      role: z.enum(roles),
      identity: IdentitySchema,
    })
    .passthrough(),
]);

export type OrganizationStatus = z.infer<typeof OrganizationStatusSchema>;
export type Session =
  | {
      readonly kind: 'live';
      readonly status: Extract<OrganizationStatus, { authenticated: true }>;
    }
  | { readonly kind: 'signed-out'; readonly organization: string | null }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'unavailable'; readonly message: string };
