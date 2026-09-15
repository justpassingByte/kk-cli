import { z } from 'zod';

export const storedCredentialSchema = z.object({
  schemaVersion: z.literal(1),
  authMethod: z.enum(['email_otp', 'api_key']),
  accessToken: z.string().min(1),
  obtainedAt: z.string().datetime().optional(),
  accessTokenExpiresAt: z.string().datetime().optional(),
  refreshToken: z.string().min(1).optional(),
  refreshTokenExpiresAt: z.string().datetime().optional(),
  sessionId: z.string().min(1).optional(),
  deviceId: z.string().optional(),
  apiKey: z.string().min(1).optional(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
  }),
});

export type StoredCredential = z.infer<typeof storedCredentialSchema>;

export interface CredentialStore {
  load(): Promise<StoredCredential | null>;
  save(credential: StoredCredential): Promise<void>;
  clear(): Promise<void>;
  withExclusive?<T>(action: () => Promise<T>): Promise<T>;
}
