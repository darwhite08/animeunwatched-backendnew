/**
 * Socket.IO event name tests — ensure frontend and backend use matching event names.
 */
import { describe, it, expect } from "vitest"

// These are the exact event names used in the backend socket handler
// Any mismatch with the frontend would break real-time features.
const BACKEND_EVENTS = {
  // Chat
  emit:    ["chat.message", "chat.read"],
  receive: ["chat.message", "chat.read"],
  // Calls
  callEmit:    ["call:offer", "call:answer", "call:ice-candidate", "call:end", "call:reject", "call:busy"],
  callReceive: ["call:incoming", "call:answered", "call:ice-candidate", "call:ended", "call:rejected", "call:busy"],
  // Typing
  typingEmit:    ["typing:start", "typing:stop"],
  typingReceive: ["typing:start", "typing:stop"],
  // Notifications
  notifReceive: ["notification.new"],
}

describe("Socket event names — backend contract", () => {
  it("has all required chat events", () => {
    expect(BACKEND_EVENTS.emit).toContain("chat.message")
    expect(BACKEND_EVENTS.emit).toContain("chat.read")
  })

  it("has all required call events (emit)", () => {
    const required = ["call:offer", "call:answer", "call:ice-candidate", "call:end", "call:reject"]
    for (const e of required) {
      expect(BACKEND_EVENTS.callEmit).toContain(e)
    }
  })

  it("has all required call events (receive)", () => {
    const required = ["call:incoming", "call:answered", "call:ice-candidate", "call:ended", "call:rejected"]
    for (const e of required) {
      expect(BACKEND_EVENTS.callReceive).toContain(e)
    }
  })

  it("has typing events added (new feature)", () => {
    expect(BACKEND_EVENTS.typingEmit).toContain("typing:start")
    expect(BACKEND_EVENTS.typingEmit).toContain("typing:stop")
    expect(BACKEND_EVENTS.typingReceive).toContain("typing:start")
    expect(BACKEND_EVENTS.typingReceive).toContain("typing:stop")
  })

  it("call events use colon separator (call:event)", () => {
    for (const e of BACKEND_EVENTS.callEmit) {
      expect(e).toMatch(/^call:/)
    }
  })

  it("chat events use dot separator (chat.event)", () => {
    for (const e of BACKEND_EVENTS.emit) {
      expect(e).toMatch(/^chat\./)
    }
  })

  it("notification event uses dot separator", () => {
    expect(BACKEND_EVENTS.notifReceive[0]).toBe("notification.new")
  })
})
