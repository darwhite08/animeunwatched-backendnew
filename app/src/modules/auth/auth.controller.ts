import { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";
import { registerSchema, loginSchema } from "./auth.schema";
import * as service from "./auth.service";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/v1/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = registerSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.register(dto);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(201).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = loginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.login(dto);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(200).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const oldToken: string | undefined = req.cookies?.aw_refresh;
    if (!oldToken) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "No refresh token" } });
      return;
    }
    const { accessToken, refreshToken } = await service.refresh(oldToken);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(200).json({ accessToken });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshToken: string | undefined = req.cookies?.aw_refresh;
    const userId: string = res.locals.user?.id;
    if (refreshToken && userId) {
      await service.logout(userId, refreshToken);
    }
    res.clearCookie("aw_refresh", { path: COOKIE_OPTS.path });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    if (userId) {
      await service.logoutAll(userId);
    }
    res.clearCookie("aw_refresh", { path: COOKIE_OPTS.path });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export function me(req: Request, res: Response): void {
  res.status(200).json({ user: res.locals.user });
}
