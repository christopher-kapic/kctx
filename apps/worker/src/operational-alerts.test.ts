import { beforeEach, describe, expect, it, vi } from "vitest";

const redisSet = vi.fn();
const sendEmail = vi.fn();
const isEmailConfigured = vi.fn(() => true);

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
// Importing the real `@starter/queue` opens IORedis sockets at import time.
vi.mock("@starter/queue", () => ({
  createRedisConnection: () => ({ set: redisSet, disconnect: () => {} }),
}));
vi.mock("@starter/mailer", () => ({
  isEmailConfigured: () => isEmailConfigured(),
  sendEmail: (args: unknown) => sendEmail(args),
}));

const { default: prisma } = await import("@starter/db");
const { sendOperationalAlert } = await import("./operational-alerts.js");

const db = prisma as unknown as { user: { findMany: ReturnType<typeof vi.fn> } };

const alert = {
  source: "worker",
  message: "boom",
  subject: "[worker] background job failed",
  html: "<p>boom</p>",
};

describe("sendOperationalAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isEmailConfigured.mockReturnValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.user.findMany.mockResolvedValue([{ id: "u1", email: "admin@example.com", role: "admin" }]);
  });

  it("emails admins when it wins the cooldown slot", async () => {
    redisSet.mockResolvedValue("OK");

    await sendOperationalAlert(alert);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", subject: alert.subject }),
    );
  });

  it("stays quiet while the cooldown is held", async () => {
    redisSet.mockResolvedValue(null);

    await sendOperationalAlert(alert);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Redis is what turns a failure repeating every minute into ONE email an
  // hour. If it is unreachable, sending anyway would mail every admin every
  // minute for the length of the outage — so skip instead.
  it("skips the alert when Redis errors instead of mailing every admin", async () => {
    redisSet.mockRejectedValue(new Error("ECONNREFUSED"));

    await sendOperationalAlert(alert);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips the alert when the Redis reservation never settles", async () => {
    vi.useFakeTimers();
    redisSet.mockReturnValue(new Promise(() => {}));

    const pending = sendOperationalAlert(alert);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(sendEmail).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
