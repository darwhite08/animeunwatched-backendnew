import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { conflict, unauth } from "../../lib/errors";
import { sendEmail, welcomeEmail } from "../../lib/email";
import type { RegisterDto, LoginDto } from "./auth.schema";

// ---------- helpers ----------

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRY as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): { userId: string } {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string };
  } catch {
    throw unauth("Invalid or expired access token");
  }
}

export function verifyRefreshToken(token: string): { userId: string } {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as { userId: string };
  } catch {
    throw unauth("Invalid or expired refresh token");
  }
}

// ---------- safe user select ----------

const userSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  role: true,
  reputation: true,
  createdAt: true,
} as const;

// ---------- service methods ----------

export async function register(dto: RegisterDto) {
  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email: dto.email } }),
    prisma.user.findUnique({ where: { username: dto.username } }),
  ]);

  if (existingEmail) throw conflict("Email is already in use");
  if (existingUsername) throw conflict("Username is already taken");

  const passwordHash = await hashPassword(dto.password);

  const user = await prisma.user.create({
    data: {
      email: dto.email,
      username: dto.username,
      displayName: dto.displayName,
      passwordHash,
    },
    select: userSelect,
  });

  sendEmail(welcomeEmail(dto.email, dto.displayName)).catch(console.error);

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt,
    },
  });

  return { user, accessToken, refreshToken };
}

export async function login(dto: LoginDto) {
  const userWithHash = await prisma.user.findUnique({
    where: { email: dto.email },
  });

  if (!userWithHash) throw unauth("Invalid email or password");

  const valid = await verifyPassword(userWithHash.passwordHash, dto.password);
  if (!valid) throw unauth("Invalid email or password");

  const user = await prisma.user.findUnique({
    where: { id: userWithHash.id },
    select: userSelect,
  });

  if (!user) throw unauth("Invalid email or password");

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt,
    },
  });

  return { user, accessToken, refreshToken };
}

export async function refresh(oldToken: string) {
  // Validate JWT signature/expiry first
  const payload = verifyRefreshToken(oldToken);

  // Look up the stored token
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: oldToken },
  });

  if (!storedToken) throw unauth("Refresh token not found");
  if (storedToken.expiresAt < new Date()) {
    // Clean up expired token
    await prisma.refreshToken.delete({ where: { token: oldToken } });
    throw unauth("Refresh token has expired");
  }

  // Rotate: delete old, issue new
  await prisma.refreshToken.delete({ where: { token: oldToken } });

  const accessToken = signAccessToken(payload.userId);
  const newRefreshToken = signRefreshToken(payload.userId);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token: newRefreshToken,
      userId: payload.userId,
      expiresAt,
    },
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(userId: string, refreshToken: string): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { token: refreshToken, userId },
  });
}

export async function logoutAll(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { userId },
  });
}
