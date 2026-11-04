import { describe, expect, it } from "vitest";
import { expandItem } from "../src/calendar/expand";
import { placeOf } from "../src/calendar/meeting";

/** One event with the given lines, expanded: its occurrence's meeting and place. */
const event = (lines: string[]) => {
  const data =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Point\r\n" +
    "DTSTART:20261022T090000Z\r\nDTEND:20261022T100000Z\r\n" +
    lines.map((l) => `${l}\r\n`).join("") +
    "END:VEVENT\r\nEND:VCALENDAR\r\n";
  const [o] = expandItem("https://cal.test/c/m.ics", "https://cal.test/c/", data, {
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-11-01T00:00:00Z"),
    tz: "Europe/Paris",
    me: [],
  });
  return { meeting: o!.meeting, location: o!.location };
};

const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ0%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d";
// As Outlook writes a Teams invitation: the link in the description, between < >, before other Teams links.
const OUTLOOK_DESCRIPTION =
  "DESCRIPTION:____\\nRéunion Microsoft Teams\\nRejoindre sur votre ordinateur\\, application mobile ou appareil de salle\\n" +
  `Cliquez ici pour participer à la réunion<${TEAMS}>\\nID de réunion : 123 456 789\\n` +
  "En savoir plus<https://aka.ms/JoinTeamsMeeting>\\nOptions de réunion<https://teams.microsoft.com/meetingOptions/?organizerId=x>";

describe("the meeting to join", () => {
  it("finds Teams in Outlook's description, and keeps the place it names", () => {
    expect(event(["LOCATION:Réunion Microsoft Teams", OUTLOOK_DESCRIPTION])).toEqual({
      meeting: { url: TEAMS, provider: "Teams" },
      location: "Réunion Microsoft Teams",
    });
  });

  it("takes Microsoft's and Google's own properties first", () => {
    expect(event([`X-MICROSOFT-SKYPETEAMSMEETINGURL:${TEAMS}`]).meeting).toEqual({ url: TEAMS, provider: "Teams" });
    expect(event(["X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", "DESCRIPTION:Aide : https://support.google.com/a/users/answer/9282720"]).meeting).toEqual({
      url: "https://meet.google.com/abc-defg-hij",
      provider: "Meet",
    });
  });

  it("takes the video CONFERENCE (RFC 7986), whatever the service, never a phone one", () => {
    const m = event(["CONFERENCE;VALUE=URI;FEATURE=PHONE:tel:+33123456789", "CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Salle:https://visio.example.org/salle-42"]).meeting;
    expect(m).toEqual({ url: "https://visio.example.org/salle-42", provider: null });
  });

  it("a Zoom link as the place is the meeting, not a place", () => {
    expect(event(["LOCATION:https://us02web.zoom.us/j/81234567890?pwd=abcDEF.1"])).toEqual({
      meeting: { url: "https://us02web.zoom.us/j/81234567890?pwd=abcDEF.1", provider: "Zoom" },
      location: null,
    });
  });

  it("unwraps a link rewritten by Outlook's Safe Links", () => {
    const wrapped = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent("https://us02web.zoom.us/j/123?pwd=x")}&data=05%7C02&reserved=0`;
    expect(event([`DESCRIPTION:Rejoindre Zoom : ${wrapped}`]).meeting).toEqual({ url: "https://us02web.zoom.us/j/123?pwd=x", provider: "Zoom" });
  });

  it("leaves other links alone: a map as the place, a web page as URL", () => {
    expect(event(["LOCATION:https://maps.app.goo.gl/xyz", "URL:https://example.com/conference-2026"])).toEqual({
      meeting: null,
      location: "https://maps.app.goo.gl/xyz",
    });
    expect(event(["LOCATION:Salle B"])).toEqual({ meeting: null, location: "Salle B" });
  });

  it("takes a link to a service we don't know from the place, then from the notes", () => {
    expect(event(["LOCATION:https://visio.ecole.fr/salle-12"])).toEqual({
      meeting: { url: "https://visio.ecole.fr/salle-12", provider: null },
      location: null,
    });
    expect(event(["DESCRIPTION:Rejoignez-nous : https://rdv.example.org/abc"]).meeting).toEqual({ url: "https://rdv.example.org/abc", provider: null });
    expect(event(["DESCRIPTION: https://rdv.example.org/abc "]).meeting).toEqual({ url: "https://rdv.example.org/abc", provider: null });
    // A known service anywhere wins over an unknown link in the place.
    expect(event(["LOCATION:https://visio.ecole.fr/salle-12", "DESCRIPTION:Ou Zoom : https://zoom.us/j/1"]).meeting).toEqual({ url: "https://zoom.us/j/1", provider: "Zoom" });
  });

  it("in the notes, prefers the link on a line that speaks of a meeting", () => {
    const desc = "DESCRIPTION:Ordre du jour : https://intranet.ecole.fr/agenda\\nVisio : https://rdv.example.org/abc";
    expect(event([desc]).meeting).toEqual({ url: "https://rdv.example.org/abc", provider: null });
  });

  it("in the notes, not a link that nothing says is the meeting's: the event's site", () => {
    expect(event(["DESCRIPTION:DevFest 2025\\nhttps://devfest.example.org/2025\\nÀ bientôt !"]).meeting).toBeNull();
    expect(event(["DESCRIPTION:Le programme : https://devfest.example.org/2025"]).meeting).toBeNull();
    // In the place, a link is there to be followed: it stays the meeting.
    expect(event(["LOCATION:https://devfest.example.org/live"]).meeting).toEqual({ url: "https://devfest.example.org/live", provider: null });
  });

  it("never takes a map, a document, a file or a help page for a meeting", () => {
    for (const link of [
      "https://docs.google.com/document/d/1abc/edit",
      "https://drive.google.com/file/d/1abc/view",
      "https://ecole.sharepoint.com/sites/x/doc.aspx",
      "https://www.google.com/maps/place/Paris",
      "https://maps.apple.com/?q=Paris",
      "https://example.org/programme.pdf",
      "https://support.google.com/calendar/answer/37135",
      "https://lists.example.org/unsubscribe?id=1",
      // An event's page, a mail's tracking link, an image (2026-11-04: an event mailed by Luma).
      "https://luma.link/nFLy5FD4Kj",
      "https://luma.com/event/evt-abc",
      "https://lu.ma/devfest",
      "https://cdn.lu.ma/cdn-cgi/image/format=auto/event-covers/x",
      "https://www.eventbrite.fr/e/atelier-123",
      "https://www.meetup.com/fr-FR/paris-js/events/1/",
      "https://gdg.community.dev/events/details/x/",
      "https://u14849509.ct.sendgrid.net/ls/click?upn=abc",
      "https://x.r.us-west-2.awstrack.me/L0/https:%2F%2Fexample.org/1/abc",
      "https://res.cloudinary.com/demo/image/upload/sample",
      "https://example.org/banner.webp",
      "https://g.co/calendar",
    ]) {
      expect(event([`DESCRIPTION:Voir ${link}`]).meeting, link).toBeNull();
    }
    expect(event(["URL:https://rdv.example.org/abc"]).meeting).toBeNull();
  });

  it("an event's page doesn't hide the meeting link after it", () => {
    const desc = "DESCRIPTION:Inscrit ! https://luma.link/nFLy5FD4Kj\\nhttps://u1.ct.sendgrid.net/ls/click?upn=a\\nLien de la visio : https://rdv.example.org/abc";
    expect(event([desc]).meeting).toEqual({ url: "https://rdv.example.org/abc", provider: null });
  });

  it("a meeting service's dial-in numbers or images are not its meeting, Teams' new domain is", () => {
    const desc = "DESCRIPTION:https://st3.zoom.us/static/6.3/image/new/topNav/Zoom_logo.png?v=1 Numéros : https://dialin.teams.microsoft.com/x?id=1 " +
      "Rejoindre : https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_x%40thread.v2/0";
    expect(event([desc]).meeting).toEqual({ url: "https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_x%40thread.v2/0", provider: "Teams" });
    expect(event(["DESCRIPTION:Par téléphone : https://dialin.teams.cloud.microsoft/x?id=1"]).meeting).toBeNull();
  });

  it("keeps a place that says more than the link", () => {
    const zoom = { url: "https://zoom.us/j/1", provider: "Zoom" };
    expect(placeOf("Salle B ; https://zoom.us/j/1", zoom)).toBe("Salle B ; https://zoom.us/j/1");
    expect(placeOf(" https://zoom.us/j/1 ", zoom)).toBeNull();
    expect(placeOf("", null)).toBeNull();
  });
});
