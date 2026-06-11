import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { env } from "../../config/env";
import { badReq } from "../../lib/errors";

const RP_ID = env.WEBAUTHN_RP_ID;
const ORIGIN = env.WEBAUTHN_ORIGIN;
const CHALLENGE_TTL = 5 * 60_000;
const challengeKey = (userId: string, kind: string) => `webauthn:${kind}:${userId}`;

export async function registrationOptions(userId: string, username: string) {
  const opts = await generateRegistrationOptions({
    rpName: "Kaiveron",
    rpID: RP_ID,
    userName: username,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    // PRF extension — the symmetric secret we derive the KRK from (spec §1, §3).
    extensions: { prf: {} } as Record<string, unknown>,
  });
  cache.set(challengeKey(userId, "reg"), opts.challenge, CHALLENGE_TTL);
  return opts;
}

export async function verifyRegistration(userId: string, response: Parameters<typeof verifyRegistrationResponse>[0]["response"]) {
  const expectedChallenge = cache.get<string>(challengeKey(userId, "reg"));
  if (!expectedChallenge) throw badReq("Registration challenge expired");
  const verification = await verifyRegistrationResponse({
    response, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) throw badReq("Passkey registration failed");
  const { credential } = verification.registrationInfo;
  await prisma.webAuthnCredential.create({
    data: {
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: credential.transports?.join(",") ?? null,
    },
  });
  cache.del(challengeKey(userId, "reg"));
  return { verified: true, credentialId: credential.id };
}

export async function authenticationOptions(userId: string) {
  const creds = await prisma.webAuthnCredential.findMany({ where: { userId }, select: { credentialId: true, transports: true } });
  const opts = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports?.split(",") as never })),
    extensions: { prf: { eval: { first: new TextEncoder().encode("kaiveron-dm-krk-v1") } } } as Record<string, unknown>,
  });
  cache.set(challengeKey(userId, "auth"), opts.challenge, CHALLENGE_TTL);
  return opts;
}

export async function verifyAuthentication(userId: string, response: Parameters<typeof verifyAuthenticationResponse>[0]["response"]) {
  const expectedChallenge = cache.get<string>(challengeKey(userId, "auth"));
  if (!expectedChallenge) throw badReq("Authentication challenge expired");
  const cred = await prisma.webAuthnCredential.findUnique({ where: { credentialId: response.id } });
  if (!cred || cred.userId !== userId) throw badReq("Unknown credential");
  const verification = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
    credential: { id: cred.credentialId, publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64")), counter: cred.counter },
  });
  if (!verification.verified) throw badReq("Passkey authentication failed");
  // Reject signature-counter regression: a non-zero counter that did not
  // advance signals a cloned authenticator (replay). Authenticators that don't
  // implement counters report 0 on both sides — allow that case.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter !== 0 && newCounter <= cred.counter) {
    throw badReq("Passkey authentication failed (counter regression)");
  }
  await prisma.webAuthnCredential.update({ where: { id: cred.id }, data: { counter: newCounter } });
  cache.del(challengeKey(userId, "auth"));
  return { verified: true };
}
