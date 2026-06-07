/**
 * Low-level Jikan v4 HTTP client with a GLOBAL token-bucket rate limiter.
 *
 * Every Jikan request in the codebase must flow through `jikanFetch` (the
 * provider, the sync worker and the read-through fallback all share this
 * module) so the process never exceeds the sustained rate. The API server
 * and the job loop run in the same process (see lib/jobRegistry.ts), so a
 * process-wide limiter IS the global limiter — no Redis needed.
 *
 * Limits: 1 req/sec sustained (env JIKAN_RATE_PER_SEC), burst of 3.
 * Retries: 429/5xx with exponential backoff (max 3, base 2s, honours
 * Retry-After). Every call logs endpoint + status + duration; exhausted
 * failures are recorded in SyncJobLog (best-effort).
 */
import { env } from "../../config/env";

// ─── Token bucket ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  /** FIFO chain so concurrent acquirers queue in order instead of racing. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSec,
    );
    this.lastRefill = now;
  }

  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take());
    // Keep the chain alive even if a waiter is rejected upstream.
    this.queue = next.catch(() => {});
    return next;
  }

  private async take(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      await sleep(((1 - this.tokens) / this.refillPerSec) * 1000);
      this.refill();
    }
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

const RATE_PER_SEC = env.JIKAN_RATE_PER_SEC;
const BURST = 3;

/** Single shared limiter for ALL Jikan traffic in this process. */
const bucket = new TokenBucket(BURST, RATE_PER_SEC);

// ─── Typed Jikan v4 payloads (fields we consume) ─────────────────────────────

export interface JikanImages {
  jpg?: { image_url?: string | null; small_image_url?: string | null; large_image_url?: string | null };
  webp?: { image_url?: string | null; small_image_url?: string | null; large_image_url?: string | null };
}

export interface JikanMalEntity {
  mal_id: number;
  type?: string;
  name: string;
  url?: string;
}

export interface JikanAnime {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  title_synonyms?: string[] | null;
  titles?: Array<{ type: string; title: string }> | null;
  type?: string | null;
  source?: string | null;
  episodes?: number | null;
  status?: string | null;
  airing?: boolean | null;
  aired?: { from?: string | null; to?: string | null } | null;
  duration?: string | null;
  rating?: string | null;
  score?: number | null;
  scored_by?: number | null;
  rank?: number | null;
  popularity?: number | null;
  members?: number | null;
  favorites?: number | null;
  synopsis?: string | null;
  background?: string | null;
  season?: string | null;
  year?: number | null;
  broadcast?: { day?: string | null; time?: string | null; timezone?: string | null } | null;
  trailer?: { youtube_id?: string | null; url?: string | null } | null;
  images?: JikanImages | null;
  genres?: JikanMalEntity[] | null;
  explicit_genres?: JikanMalEntity[] | null;
  themes?: JikanMalEntity[] | null;
  demographics?: JikanMalEntity[] | null;
  studios?: JikanMalEntity[] | null;
  producers?: JikanMalEntity[] | null;
  licensors?: JikanMalEntity[] | null;
  /** Present on /anime/{id}/full only */
  relations?: Array<{ relation: string; entry: JikanMalEntity[] }> | null;
}

export interface JikanEpisode {
  mal_id: number; // episode number on MAL
  title?: string | null;
  title_japanese?: string | null;
  title_romanji?: string | null; // Jikan's actual (misspelled) field name
  aired?: string | null;
  score?: number | null;
  filler?: boolean | null;
  recap?: boolean | null;
  synopsis?: string | null;
}

export interface JikanPagination {
  last_visible_page: number;
  has_next_page: boolean;
  items?: { count: number; total: number; per_page: number };
}

export interface JikanListResponse<T> {
  data: T[];
  pagination?: JikanPagination;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class JikanError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly path: string,
  ) {
    super(message);
    this.name = "JikanError";
  }
  /** 404 means the malId genuinely doesn't exist — never retried. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

// ─── Core fetch with retry/backoff ───────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;

async function recordFailure(path: string, error: string, durationMs: number): Promise<void> {
  try {
    const { prisma } = await import("../../config/prisma");
    await prisma.syncJobLog.create({
      data: { jobType: "jikan-http", status: "failed", error: `${path}: ${error}`.slice(0, 2000), durationMs },
    });
  } catch {
    // Logging must never take down the caller.
  }
}

/**
 * Rate-limited GET against the Jikan API. `path` starts with "/".
 * Throws JikanError after retries are exhausted (or immediately on 4xx ≠ 429).
 */
export async function jikanFetch<T>(path: string, opts?: { timeoutMs?: number }): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const url = `${env.JIKAN_BASE_URL}${path}`;
  const started = Date.now();
  let lastError: JikanError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await bucket.acquire();
    const attemptStart = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const ms = Date.now() - attemptStart;
      console.warn(`[jikan] GET ${path} network-error ${ms}ms (attempt ${attempt + 1}): ${(err as Error).message}`);
      lastError = new JikanError((err as Error).message, null, path);
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      break;
    }

    const ms = Date.now() - attemptStart;
    if (res.ok) {
      console.log(`[jikan] GET ${path} ${res.status} ${ms}ms`);
      return (await res.json()) as T;
    }

    console.warn(`[jikan] GET ${path} ${res.status} ${ms}ms (attempt ${attempt + 1})`);
    lastError = new JikanError(`Jikan returned ${res.status}`, res.status, path);

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) break;

    // Honour Retry-After (seconds) when present, else exponential backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** attempt;
    await sleep(delay);
  }

  const total = Date.now() - started;
  // 404s are an expected outcome on the read-through path — don't pollute the log.
  if (!lastError?.isNotFound) {
    void recordFailure(path, lastError?.message ?? "unknown", total);
  }
  throw lastError ?? new JikanError("Unknown Jikan failure", null, path);
}

// ─── Endpoint helpers ────────────────────────────────────────────────────────

export async function getAnimeFull(malId: number, opts?: { timeoutMs?: number }): Promise<JikanAnime> {
  const res = await jikanFetch<{ data: JikanAnime }>(`/anime/${malId}/full`, opts);
  return res.data;
}

/** Paginated, 100 episodes per page. */
export function getAnimeEpisodesPage(malId: number, page = 1): Promise<JikanListResponse<JikanEpisode>> {
  return jikanFetch<JikanListResponse<JikanEpisode>>(`/anime/${malId}/episodes?page=${page}`);
}

/** 25 items per page. */
export function getTopAnimePage(page = 1): Promise<JikanListResponse<JikanAnime>> {
  return jikanFetch<JikanListResponse<JikanAnime>>(`/top/anime?page=${page}`);
}

export function getSeasonPage(
  year: number,
  season: "winter" | "spring" | "summer" | "fall",
  page = 1,
): Promise<JikanListResponse<JikanAnime>> {
  return jikanFetch<JikanListResponse<JikanAnime>>(`/seasons/${year}/${season}?page=${page}`);
}

export function getSeasonNowPage(page = 1): Promise<JikanListResponse<JikanAnime>> {
  return jikanFetch<JikanListResponse<JikanAnime>>(`/seasons/now?page=${page}`);
}

export function searchAnimePage(
  query: string,
  opts?: { page?: number; limit?: number },
): Promise<JikanListResponse<JikanAnime>> {
  const qs = new URLSearchParams({ q: query, page: String(opts?.page ?? 1) });
  if (opts?.limit) qs.set("limit", String(opts.limit));
  return jikanFetch<JikanListResponse<JikanAnime>>(`/anime?${qs.toString()}`);
}

/**
 * Browse /anime with arbitrary query params — used by the legacy browse
 * fallback. Caller builds the query string.
 */
export function browseAnime(queryString: string): Promise<JikanListResponse<JikanAnime>> {
  return jikanFetch<JikanListResponse<JikanAnime>>(`/anime?${queryString}`);
}

/** Raw passthrough for endpoints we don't persist (characters, staff…). */
export function getRaw<T = unknown>(path: string): Promise<T> {
  return jikanFetch<T>(path);
}
