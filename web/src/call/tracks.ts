import type { Lang } from "./api";

// Which remote audio the viewer hears (team spec §5 step 4; lesson R2: attaching every remote track plays each phrase
// twice). Pure, so it is easy to test and the hook never decides it inline.

/** The translator's identity in every coordination room (worker contract). */
export const TRANSLATOR_IDENTITY = "translator";
const HUMAN_PREFIX = "user-";

const LANGS: readonly Lang[] = ["en", "ru", "zh"];
export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

/** `tr:<lang>:<speakerIdentity>` → its parts, else null. */
export function parseTranslationTrack(name: string): { lang: Lang; speaker: string } | null {
  const m = /^tr:([a-z]{2}):(.+)$/.exec(name);
  return m && isLang(m[1]) ? { lang: m[1], speaker: m[2] } : null;
}

export type RemoteAudio = {
  /** Publishing participant's identity. */
  participant: string;
  /** Publishing participant's `lang` attribute (set by the server in the token; never by the client). */
  participantLang: string | undefined;
  /** Publication (track) name. */
  trackName: string;
  /** The publication is a microphone (Track.Source.Microphone). */
  isMicrophone: boolean;
  /** For a translator track: the original speaker's `lang` attribute, when that speaker is in the room. */
  speakerLang?: string;
};

/** The Coordination Host's identities: exactly "host" or "host-<suffix>". */
const isHost = (identity: string) => identity === "host" || identity.startsWith("host-");

/**
 * True only for: the translator's `tr:<myLang>:<speaker>` (a translation of someone else), the Coordination Host's
 * `host:<myLang>`, and the raw microphone of a human who speaks my language. Never my own voice, never another
 * language, never the original of a foreign-language speaker, and never a translator track for a speaker of my own
 * language (I already hear their microphone: the worker should not publish it, and the client does not trust that).
 */
export function shouldHear(a: RemoteAudio, me: { identity: string; lang: Lang }): boolean {
  if (a.participant === me.identity) return false;
  if (a.participant === TRANSLATOR_IDENTITY) {
    const t = parseTranslationTrack(a.trackName);
    return t !== null && t.lang === me.lang && t.speaker !== me.identity && a.speakerLang !== me.lang;
  }
  if (isHost(a.participant)) return a.trackName === `host:${me.lang}`;
  return a.participant.startsWith(HUMAN_PREFIX) && a.isMicrophone && a.participantLang === me.lang;
}
