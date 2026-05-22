/**
 * Reports which commit this running process was built from.
 *
 * On Render, `RENDER_GIT_COMMIT` is injected automatically per deploy. Locally
 * we fall back to "dev". The `check-deploys.sh` script at the project root
 * compares this against `git rev-parse HEAD` to verify a push has actually
 * gone live.
 */
export type VersionInfo = {
  sha: string;
  shortSha: string;
  env: string;
  service: "kaiveron-backend";
  ts: string;
};

export function getVersion(): VersionInfo {
  const sha = process.env.RENDER_GIT_COMMIT || "dev";
  return {
    sha,
    shortSha: sha === "dev" ? "dev" : sha.slice(0, 7),
    env: process.env.NODE_ENV || "development",
    service: "kaiveron-backend",
    ts: new Date().toISOString(),
  };
}
