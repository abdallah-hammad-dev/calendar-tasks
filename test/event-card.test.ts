import { describe, expect, it } from "vitest";
import { answerStatus, openLabel } from "../src/calendar/event-card";
import { t } from "../src/i18n";

describe("answerStatus", () => {
  it("says nothing before an answer", () => {
    expect(answerStatus(null, "synced")).toBeNull();
    expect(answerStatus({ partstat: "NEEDS-ACTION" }, "synced")).toBeNull();
  });

  it("follows the answer from this device to the organizer", () => {
    expect(answerStatus({ partstat: "ACCEPTED" }, "queued")?.text).toBe(t("card.answerSending"));
    expect(answerStatus({ partstat: "ACCEPTED" }, "offline")?.text).toBe(t("card.answerOffline"));
    expect(answerStatus({ partstat: "ACCEPTED" }, "synced")?.text).toBe(t("card.answerSaved"));
    expect(answerStatus({ partstat: "TENTATIVE", relay: "pending" }, "synced")?.text).toBe(t("view.rsvpPending"));
    expect(answerStatus({ partstat: "TENTATIVE", relay: "confirmed" }, "synced")?.text).toBe(t("card.answerRelayed"));
    expect(answerStatus({ partstat: "ACCEPTED", relay: "failed:token expired" }, "synced")).toEqual({
      icon: "triangle-alert",
      text: t("view.rsvpFailed", { reason: "token expired" }),
      failed: true,
    });
  });

  it("puts a change still on this device before the backend's state of the previous one", () => {
    expect(answerStatus({ partstat: "ACCEPTED", relay: "confirmed" }, "queued")?.text).toBe(t("card.answerSending"));
  });
});

describe("openLabel", () => {
  it("offers to create an event's note until it exists", () => {
    expect(openLabel({ kind: "event" }, false)).toEqual({ text: t("menu.createNote"), icon: "file-plus" });
    expect(openLabel({ kind: "event" }, true)).toEqual({ text: t("menu.open"), icon: "file-text" });
    expect(openLabel({ kind: "deadline" }, false).text).toBe(t("menu.openTask"));
  });
});
