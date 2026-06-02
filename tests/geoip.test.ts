import { describe, it, expect } from "vitest"
import { haversineKm } from "../app/src/lib/geoip"

describe("haversineKm", () => {
  it("0 for identical points", () => {
    expect(haversineKm({ lat: 40, lon: -74 }, { lat: 40, lon: -74 })).toBe(0)
  })

  it("NYC → London ≈ 5570 km (±50 km)", () => {
    // 40.7128°N, 74.0060°W → 51.5074°N, 0.1278°W
    const d = haversineKm({ lat: 40.7128, lon: -74.006 }, { lat: 51.5074, lon: -0.1278 })
    expect(d).toBeGreaterThan(5520)
    expect(d).toBeLessThan(5620)
  })

  it("Tokyo → Sydney ≈ 7820 km (±100 km)", () => {
    // 35.6762°N, 139.6503°E → -33.8688°S, 151.2093°E
    const d = haversineKm({ lat: 35.6762, lon: 139.6503 }, { lat: -33.8688, lon: 151.2093 })
    expect(d).toBeGreaterThan(7720)
    expect(d).toBeLessThan(7920)
  })

  it("Antipodal points are ~20015 km apart (max Earth distance)", () => {
    const d = haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })
    expect(d).toBeGreaterThan(20000)
    expect(d).toBeLessThan(20030)
  })

  it("Short hop (NYC → Newark ~16 km)", () => {
    const d = haversineKm({ lat: 40.7128, lon: -74.006 }, { lat: 40.7357, lon: -74.1724 })
    expect(d).toBeGreaterThan(10)
    expect(d).toBeLessThan(20)
  })
})
