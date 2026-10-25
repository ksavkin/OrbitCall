// One root audio layer for the page (lesson R4): every remote audio track the viewer hears lives in one <audio>
// element in a hidden container under <body>, outside any panel, so re-renders, tabs or layout changes never detach
// it. An element goes away only when its publication stops being heard. The idea comes from the light VKS
// RootAudioManager; this is a small rewrite for livekit-client tracks.

type Attachable = { attach(element: HTMLMediaElement): HTMLMediaElement; detach(element: HTMLMediaElement): HTMLMediaElement };

type Sink = { element: HTMLAudioElement; track: Attachable };

export class RootAudio {
  readonly #sinks = new Map<string, Sink>();
  readonly #container: HTMLDivElement;
  #sinkId: string | undefined;

  /** `onBlocked` fires when the browser refuses to play an element (autoplay policy): show "Enable sound". */
  constructor(readonly outputSelectable: boolean, private readonly onBlocked: () => void = () => undefined) {
    this.#container = document.createElement("div");
    this.#container.hidden = true;
    this.#container.dataset.testid = "call-root-audio";
    document.body.appendChild(this.#container);
  }

  /** Plays `track` for publication `id` (same element across re-subscriptions); `who` is a debug label. */
  attach(id: string, track: Attachable, who: string): void {
    const sink = this.#sinks.get(id);
    if (sink) {
      if (sink.track === track) return;
      sink.track.detach(sink.element);
      sink.track = track;
      track.attach(sink.element);
      return;
    }
    const element = document.createElement("audio");
    element.autoplay = true;
    element.dataset.publication = id;
    element.dataset.participant = who;
    this.#container.appendChild(element);
    track.attach(element);
    // Elements attached after the joining click may be refused individually (Safari): report it instead of silence.
    void element.play().catch(() => this.onBlocked());
    if (this.outputSelectable && this.#sinkId) void element.setSinkId(this.#sinkId).catch(() => undefined);
    this.#sinks.set(id, { element, track });
  }

  detach(id: string): void {
    const sink = this.#sinks.get(id);
    if (!sink) return;
    sink.track.detach(sink.element);
    sink.element.remove();
    this.#sinks.delete(id);
  }

  /** Output device for every element, now and later ("" or undefined = the system default); Chrome only. */
  setSinkId(sinkId: string | undefined): void {
    this.#sinkId = sinkId || undefined;
    if (!this.outputSelectable) return;
    for (const s of this.#sinks.values()) void s.element.setSinkId(sinkId ?? "").catch(() => undefined);
  }

  /** Retries every element after a user gesture; true when all of them play. */
  async resume(): Promise<boolean> {
    const results = await Promise.allSettled([...this.#sinks.values()].map((s) => s.element.play()));
    return results.every((r) => r.status === "fulfilled");
  }

  /** The attached elements (for the test page's debug view). */
  elements(): HTMLAudioElement[] {
    return [...this.#sinks.values()].map((s) => s.element);
  }

  get size(): number {
    return this.#sinks.size;
  }

  dispose(): void {
    for (const id of [...this.#sinks.keys()]) this.detach(id);
    this.#container.remove();
  }
}
