import { z } from 'zod';

const commonTokenResponseShape = {
  schemaVersion: z.number().optional(),
  token: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.string().datetime().optional(),
  deviceId: z.string().optional(),
};

const userSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
});

const legacyLoginCompatibilityShape = {
  // The legacy backend contract still emits an empty placeholder. The Node
  // client accepts but never relies on this field for authentication.
  licenseId: z.string().optional(),
};

export const otpLoginResponseSchema = z
  .object({
    ...commonTokenResponseShape,
    ...legacyLoginCompatibilityShape,
    authMethod: z.literal('email_otp'),
    user: userSchema,
    refreshToken: z.string().min(1).optional(),
    refreshTokenExpiresAt: z.string().datetime().optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

export const apiKeyLoginResponseSchema = z
  .object({
    ...commonTokenResponseShape,
    ...legacyLoginCompatibilityShape,
    authMethod: z.literal('api_key'),
    user: userSchema,
  })
  .strict();

export const loginResponseSchema = z.discriminatedUnion('authMethod', [
  otpLoginResponseSchema,
  apiKeyLoginResponseSchema,
]);

export const refreshResponseSchema = z
  .object({
    ...commonTokenResponseShape,
    authMethod: z.literal('email_otp').optional(),
    refreshToken: z.string().min(1),
    refreshTokenExpiresAt: z.string().datetime(),
    sessionId: z.string().min(1).optional(),
    user: userSchema.optional(),
  })
  .strict();

export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type OtpLoginResponse = z.infer<typeof otpLoginResponseSchema>;
export type ApiKeyLoginResponse = z.infer<typeof apiKeyLoginResponseSchema>;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
