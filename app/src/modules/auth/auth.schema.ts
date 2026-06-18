import { z } from "zod";

// Password requirements: minimum 10 chars + at least 3 character classes
// (lowercase, uppercase, digit, special). Following NIST SP 800-63B § 5.1.1.2:
// length is far more important than complexity, so we don't require all 4 classes.
const PASSWORD_RULES = z.string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password too long")
  .refine((p) => {
    let classes = 0
    if (/[a-z]/.test(p)) classes++
    if (/[A-Z]/.test(p)) classes++
    if (/[0-9]/.test(p)) classes++
    if (/[^a-zA-Z0-9]/.test(p)) classes++
    return classes >= 3
  }, "Use at least 3 of: lowercase, uppercase, number, special character")
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()),
    "This password is too common — please choose a stronger one")

// Tiny embedded denylist for the most-leaked passwords; full check would use
// haveibeenpwned k-anonymity API but that adds an external dependency.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789",
  "qwerty", "qwerty123", "abc123", "letmein", "welcome",
  "admin", "admin123", "iloveyou", "monkey", "1234567890",
  "kaiveron", "kaiveron123", "anime123", "narutorun",
])

export const registerSchema = z.object({
  email: z.string().email(),
  // Usernames are case-insensitive identities — normalize to lowercase so the
  // @handle and invite link (kaiveron.com/join/<handle>) are always consistent.
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).transform((s) => s.toLowerCase()),
  displayName: z.string().min(1).max(60),
  password: PASSWORD_RULES,
  referredBy: z.string().max(30).optional().transform((s) => s?.toLowerCase()), // referral @handle (case-insensitive)
  inviteCode: z.string().trim().max(40).optional(), // required only when invite-only mode is on (enforced in register())
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  // Optional second factor: a 6-digit TOTP code or an 8+ char backup code.
  // Required only when the account has TOTP enabled (enforced in login()).
  totpCode: z.string().trim().min(6).max(20).optional(),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto    = z.infer<typeof loginSchema>;

// OAuth — frontend sends the provider's id_token after user authenticates via popup
export const googleLoginSchema = z.object({
  idToken: z.string().min(1, "Google ID token required"),
  // Carried through on signup so Google works under invite-only (gate enforced
  // server-side; ignored for existing users logging in).
  inviteCode: z.string().trim().max(40).optional(),
  referredBy: z.string().max(30).optional().transform((s) => s?.toLowerCase()),
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
  newPassword:     PASSWORD_RULES,
});

export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token:       z.string().min(20).max(200),
  newPassword: PASSWORD_RULES,
});

export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordDto  = z.infer<typeof resetPasswordSchema>;

export const deleteAccountSchema = z.object({
  // Require password confirmation for security (skipped for OAuth-only accounts)
  password: z.string().optional(),
  confirm:  z.literal("DELETE MY ACCOUNT"),
});

export type DeleteAccountDto = z.infer<typeof deleteAccountSchema>;
