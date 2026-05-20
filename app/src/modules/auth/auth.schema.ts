import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  displayName: z.string().min(1).max(60),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto    = z.infer<typeof loginSchema>;

// OAuth — frontend sends the provider's id_token after user authenticates via popup
export const googleLoginSchema = z.object({
  idToken: z.string().min(1, "Google ID token required"),
});

export const appleLoginSchema = z.object({
  idToken:     z.string().min(1, "Apple ID token required"),
  // Apple only sends name/email on the FIRST sign-in; capture and persist them
  email:       z.string().email().optional(),
  firstName:   z.string().optional(),
  lastName:    z.string().optional(),
});

export type GoogleLoginDto = z.infer<typeof googleLoginSchema>;
export type AppleLoginDto  = z.infer<typeof appleLoginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password required"),
  newPassword:     z.string().min(8).max(128),
});

export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
