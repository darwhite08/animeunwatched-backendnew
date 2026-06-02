import { runAnomalyScan } from "../lib/anomalyDetector"

/**
 * Wrapper job for the in-process scheduler. Runs every 5 min.
 * Each scan covers the last 15-60 min of activity (per-detector windows).
 */
export async function runAnomalyScanJob(): Promise<{ detected: number; byKind: Record<string, number> }> {
  return runAnomalyScan()
}
