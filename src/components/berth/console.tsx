import { useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { LockKeyhole, RefreshCw, X } from "lucide-react";
import { dockGesture, keepSecret, releaseDock, runDockTask, viewDock } from "@/lib/berth/fns";
import { SUGGESTED, useDockStore, type DockRecord } from "@/lib/berth/store";
import type { DockResult, Surface } from "@/lib/berth/types";

type Phase = "idle" | "working" | "ready" | "hold" | "challenge" | "error";

type Session = {
  surface: Surface | null;
  steps: { label: string }[];
  summary: string;
  phase: Phase;
  pendingLabel: string | null;
  error: string;
  vaultHeld: boolean;
};

const EMPTY: Session = {
  surface: null,
  steps: [],
  summary: "",
  phase: "idle",
  pendingLabel: null,
  error: "",
  vaultHeld: false,
};

const PROMPTS = [
  "Summarize this page in three sentences.",
  "What is the main heading?",
  "List the first few links. Don't open them.",
];

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function normalizeUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function apply(result: DockResult, prev: Session, mode: "replace" | "append"): Session {
  if (!result.ok) return { ...prev, phase: "error", error: result.error };
  return {
    surface: result.surface,
    steps: (mode === "append" ? [...prev.steps, ...result.steps] : result.steps).slice(-12),
    summary: result.summary || (mode === "append" ? prev.summary : ""),
    phase: result.status,
    pendingLabel: result.pendingLabel,
    error: "",
    vaultHeld: result.vaultHeld,
  };
}

function statusWord(phase: Phase) {
  if (phase === "working") return "Working";
  if (phase === "challenge") return "Needs you";
  if (phase === "hold") return "Waiting";
  if (phase === "error") return "Stopped";
  if (phase === "ready") return "Open";
  return "Idle";
}

export function Console() {
  const docks = useDockStore((state) => state.docks);
  const activeId = useDockStore((state) => state.activeId);
  const add = useDockStore((state) => state.add);
  const remove = useDockStore((state) => state.remove);
  const update = useDockStore((state) => state.update);
  const setActive = useDockStore((state) => state.setActive);
  const view = useServerFn(viewDock);
  const run = useServerFn(runDockTask);
  const act = useServerFn(dockGesture);
  const keep = useServerFn(keepSecret);
  const release = useServerFn(releaseDock);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [task, setTask] = useState("");
  const [keys, setKeys] = useState("");

  useEffect(() => {
    void useDockStore.persist.rehydrate();
  }, []);

  const active = docks.find((dock) => dock.id === activeId) ?? null;
  const session = (active && sessions[active.id]) || EMPTY;
  const busy = session.phase === "working";

  function write(id: string, next: Session) {
    setSessions((current) => ({ ...current, [id]: next }));
  }

  async function openDock(dock: DockRecord, currentUrl?: string) {
    const prev = sessions[dock.id] ?? EMPTY;
    write(dock.id, { ...prev, phase: "working", error: "" });
    try {
      const result = await view({
        data: { id: dock.id, homeUrl: dock.url, currentUrl: currentUrl || prev.surface?.url || dock.url },
      });
      write(dock.id, apply(result, prev, "replace"));
    } catch {
      write(dock.id, { ...prev, phase: "error", error: "The dock didn't answer." });
    }
  }

  function createDock(name: string, url: string) {
    const home = normalizeUrl(url);
    if (!home) return;
    let host = home;
    try {
      host = new URL(home).hostname.replace(/^www\./, "");
    } catch {
      host = home;
    }
    const dock: DockRecord = {
      id: crypto.randomUUID().replace(/-/g, ""),
      name: name.trim() || host,
      url: home,
      memory: "",
      vaultLabel: "",
    };
    add(dock);
    void openDock(dock, home);
  }

  async function onRun(text: string) {
    if (!active || busy) return;
    const job = text.trim();
    if (!job) return;
    const prev = sessions[active.id] ?? EMPTY;
    write(active.id, { ...prev, phase: "working", error: "", pendingLabel: null });
    try {
      const result = await run({
        data: {
          id: active.id,
          homeUrl: active.url,
          currentUrl: prev.surface?.url || active.url,
          task: job,
          memory: active.memory,
        },
      });
      write(active.id, apply(result, { ...prev, steps: [] }, "replace"));
    } catch {
      write(active.id, { ...prev, phase: "error", error: "The dock didn't answer." });
    }
  }

  async function onGesture(payload: {
    kind: "click" | "type" | "follow" | "approve" | "dismiss" | "refresh";
    x?: number;
    y?: number;
    text?: string;
    href?: string;
  }) {
    if (!active || busy) return;
    const prev = sessions[active.id] ?? EMPTY;
    write(active.id, { ...prev, phase: "working", error: "" });
    try {
      const result = await act({
        data: {
          id: active.id,
          homeUrl: active.url,
          currentUrl: prev.surface?.url || active.url,
          ...payload,
        },
      });
      write(active.id, apply(result, prev, "append"));
    } catch {
      write(active.id, { ...prev, phase: "error", error: "The dock didn't answer." });
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-4 lg:px-6 lg:py-6">
      <header className="flex items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-brass">Site docks</p>
          <h1 className="font-display text-3xl italic leading-none text-fg lg:text-4xl">Berth</h1>
        </div>
        <p className="max-w-56 text-right text-sm text-muted lg:max-w-xs">
          Chrome stays on this host. You send the task.
        </p>
      </header>

      <div className="mt-4 flex min-w-0 flex-1 flex-col gap-4 lg:flex-row">
        <aside className="order-2 lg:order-1 lg:w-56 lg:shrink-0">
          <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {docks.map((dock) => {
              const selected = dock.id === active?.id;
              const phase = sessions[dock.id]?.phase ?? "idle";
              return (
                <div key={dock.id} className="flex min-w-44 shrink-0 lg:min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setActive(dock.id);
                      if (!sessions[dock.id]?.surface) void openDock(dock);
                    }}
                    className={cx(
                      "min-h-11 flex-1 border px-3 py-2 text-left",
                      selected ? "border-brass bg-surface" : "border-line bg-bg",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Lamp phase={phase} />
                      <span className="truncate text-sm font-medium">{dock.name}</span>
                    </span>
                    <span className="berth-url mt-1 block truncate text-xs text-muted">{dock.url}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${dock.name}`}
                    className="min-h-11 min-w-11 border border-l-0 border-line text-muted"
                    onClick={() => {
                      remove(dock.id);
                      void release({ data: { id: dock.id } });
                    }}
                  >
                    <X className="mx-auto size-4" />
                  </button>
                </div>
              );
            })}
          </div>
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              createDock(String(data.get("name") ?? ""), String(data.get("url") ?? ""));
              event.currentTarget.reset();
            }}
          >
            <p className="text-xs font-medium uppercase tracking-widest text-muted">New dock</p>
            <input
              name="name"
              placeholder="Name"
              aria-label="Dock name"
              className="min-h-11 border border-line bg-bg px-3 text-base text-fg outline-none placeholder:text-muted focus:border-brass"
            />
            <input
              name="url"
              required
              placeholder="https://example.com"
              aria-label="Site address"
              className="min-h-11 border border-line bg-bg px-3 text-base text-fg outline-none placeholder:text-muted focus:border-brass"
            />
            <button type="submit" className="min-h-11 bg-brass px-3 text-sm font-medium text-brass-ink">
              Open a dock
            </button>
          </form>
        </aside>

        <section className="order-1 min-w-0 flex-1 lg:order-2" aria-busy={busy}>
          {!active && (
            <div className="border border-line bg-surface p-5">
              <h2 className="font-display text-2xl italic">One site. One dock.</h2>
              <p className="mt-2 max-w-xl text-sm text-muted">
                The page opens in Chrome on this host. Ask in plain language. A saved login stays here and is
                never shown to the assistant. If a site asks for a person, you finish that check on the view.
              </p>
              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                {SUGGESTED.map((item) => (
                  <button
                    key={item.url}
                    type="button"
                    onClick={() => createDock(item.name, item.url)}
                    className="min-h-11 border border-line bg-bg px-3 py-3 text-left hover:border-brass"
                  >
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="mt-1 block text-xs text-muted">{item.blurb}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {active && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Lamp phase={session.phase} />
                    <h2 className="truncate font-display text-2xl italic">{active.name}</h2>
                    <span className="text-xs uppercase tracking-widest text-muted">{statusWord(session.phase)}</span>
                  </div>
                  <p className="berth-url text-xs text-muted">{session.surface?.url || active.url}</p>
                </div>
                <button
                  type="button"
                  aria-label="Refresh the view"
                  disabled={busy}
                  onClick={() => void onGesture({ kind: "refresh" })}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center border border-line text-fg disabled:opacity-40"
                >
                  <RefreshCw className="size-4" />
                </button>
              </div>

              <Frame>
                {session.phase === "challenge" && (
                  <p className="border-b border-brass bg-surface px-3 py-2 text-sm text-fg">
                    This site wants a person. Use the view, then refresh.
                  </p>
                )}
                {session.pendingLabel && (
                  <div className="flex flex-col gap-2 border-b border-brass px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm">{session.pendingLabel}</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onGesture({ kind: "approve" })}
                        className="min-h-11 bg-brass px-3 text-sm font-medium text-brass-ink disabled:opacity-40"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onGesture({ kind: "dismiss" })}
                        className="min-h-11 border border-line px-3 text-sm disabled:opacity-40"
                      >
                        Leave it
                      </button>
                    </div>
                  </div>
                )}
                <View
                  surface={session.surface}
                  busy={busy}
                  onPoint={(x, y) => void onGesture({ kind: "click", x, y })}
                  onFollow={(href) => void onGesture({ kind: "follow", href })}
                />
              </Frame>

              {session.surface?.engine === "chrome" && (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = keys;
                    setKeys("");
                    void onGesture({ kind: "type", text });
                  }}
                >
                  <input
                    value={keys}
                    onChange={(event) => setKeys(event.target.value)}
                    placeholder="Type into the page. Passwords belong in the vault."
                    aria-label="Keystrokes for the page"
                    className="min-h-11 min-w-0 flex-1 border border-line bg-bg px-3 text-base outline-none placeholder:text-muted focus:border-brass"
                  />
                  <button
                    type="submit"
                    disabled={busy || !keys.trim()}
                    className="min-h-11 border border-line px-3 text-sm disabled:opacity-40"
                  >
                    Send
                  </button>
                </form>
              )}

              {session.surface?.engine === "reader" && (
                <p className="text-sm text-muted">
                  Chrome didn't start on this host, so this dock is reading the page. Links stay on the same site.
                </p>
              )}

              {session.summary && (
                <blockquote className="border-l-2 border-brass pl-3 text-sm text-fg">{session.summary}</blockquote>
              )}
              {session.error && <p className="text-sm text-brass">{session.error}</p>}

              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onRun(task);
                }}
              >
                <label htmlFor="berth-task" className="text-xs font-medium uppercase tracking-widest text-muted">
                  Task
                </label>
                <textarea
                  id="berth-task"
                  rows={2}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void onRun(task);
                    }
                  }}
                  placeholder="Ask for what you want from this site."
                  className="min-h-11 w-full resize-y border border-line bg-bg px-3 py-2 text-base outline-none placeholder:text-muted focus:border-brass"
                />
                <div className="flex flex-wrap gap-2">
                  {PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      disabled={busy || !session.surface}
                      onClick={() => {
                        setTask(prompt);
                        void onRun(prompt);
                      }}
                      className="min-h-11 border border-line px-3 text-left text-xs text-muted disabled:opacity-40"
                    >
                      {prompt}
                    </button>
                  ))}
                  <button
                    type="submit"
                    disabled={busy || !session.surface || !task.trim()}
                    className="min-h-11 bg-brass px-4 text-sm font-medium text-brass-ink disabled:opacity-40"
                  >
                    Run
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>

        <aside className="order-3 flex flex-col gap-4 lg:w-72 lg:shrink-0">
          <div className="border border-line p-3">
            <h2 className="text-xs font-medium uppercase tracking-widest text-muted">Log</h2>
            {session.steps.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Steps show up here. The assistant reads the page, then acts.</p>
            ) : (
              <ol className="mt-3 flex flex-col gap-2">
                {session.steps.map((step, index) => (
                  <li key={`${step.label}-${index}`} className="flex gap-2 text-sm">
                    <span className="w-5 shrink-0 text-brass tabular-nums">{index + 1}</span>
                    <span>{step.label}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {active && (
            <>
              <label className="flex flex-col gap-2 text-xs font-medium uppercase tracking-widest text-muted">
                Dock note
                <textarea
                  value={active.memory}
                  onChange={(event) => update(active.id, { memory: event.target.value.slice(0, 400) })}
                  rows={3}
                  placeholder="What should it remember about this site?"
                  className="border border-line bg-bg px-3 py-2 text-base font-normal normal-case tracking-normal text-fg outline-none placeholder:text-muted focus:border-brass"
                />
              </label>
              <form
                className="border border-line p-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!active) return;
                  const data = new FormData(event.currentTarget);
                  const label = String(data.get("label") ?? "").slice(0, 80);
                  const secret = String(data.get("secret") ?? "");
                  update(active.id, { vaultLabel: label });
                  const result = await keep({ data: { id: active.id, secret } });
                  const prev = sessions[active.id] ?? EMPTY;
                  if (!result.ok) {
                    write(active.id, { ...prev, phase: "error", error: result.error });
                    return;
                  }
                  if ("held" in result) {
                    write(active.id, { ...prev, vaultHeld: result.held, error: "" });
                  }
                  event.currentTarget.reset();
                }}
              >
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted">
                  <LockKeyhole className="size-3.5" />
                  Vault
                </div>
                <p className="mt-2 text-sm text-muted">
                  {session.vaultHeld
                    ? `${active.vaultLabel || "Saved login"} is in this host's memory. The assistant can't read it.`
                    : "Held on this host until it restarts. Never sent to the assistant."}
                </p>
                <input
                  name="label"
                  defaultValue={active.vaultLabel}
                  placeholder="Label"
                  aria-label="Login label"
                  className="mt-3 min-h-11 w-full border border-line bg-bg px-3 text-base outline-none placeholder:text-muted focus:border-brass"
                />
                <input
                  name="secret"
                  type="password"
                  autoComplete="off"
                  placeholder="Password"
                  aria-label="Password"
                  className="mt-2 min-h-11 w-full border border-line bg-bg px-3 text-base outline-none placeholder:text-muted focus:border-brass"
                />
                <div className="mt-2 flex gap-2">
                  <button type="submit" className="min-h-11 flex-1 bg-brass px-3 text-sm font-medium text-brass-ink">
                    Keep here
                  </button>
                  <button
                    type="button"
                    className="min-h-11 border border-line px-3 text-sm"
                    onClick={async () => {
                      const result = await keep({ data: { id: active.id, secret: "" } });
                      const prev = sessions[active.id] ?? EMPTY;
                      if (result.ok) write(active.id, { ...prev, vaultHeld: false });
                    }}
                  >
                    Clear
                  </button>
                </div>
              </form>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Lamp({ phase }: { phase: Phase }) {
  const lit = phase === "working" || phase === "challenge" || phase === "hold";
  return (
    <span
      className={cx("inline-block size-2 shrink-0 rounded-full", lit ? "bg-brass" : "bg-line", phase === "working" && "lamp-pulse")}
      aria-hidden="true"
    />
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="relative border border-line bg-bg">
      <span className="pointer-events-none absolute top-0 left-0 size-3 border-t border-l border-brass" />
      <span className="pointer-events-none absolute top-0 right-0 size-3 border-t border-r border-brass" />
      <span className="pointer-events-none absolute bottom-0 left-0 size-3 border-b border-l border-brass" />
      <span className="pointer-events-none absolute right-0 bottom-0 size-3 border-r border-b border-brass" />
      {children}
    </div>
  );
}

function View({
  surface,
  busy,
  onPoint,
  onFollow,
}: {
  surface: Surface | null;
  busy: boolean;
  onPoint: (x: number, y: number) => void;
  onFollow: (href: string) => void;
}) {
  if (!surface) {
    return (
      <div className="berth-view flex items-end overflow-hidden">
        <div className="relative h-0.5 w-full overflow-hidden bg-line">
          {busy && <div className="scan-line h-full w-1/3 bg-brass" />}
        </div>
      </div>
    );
  }
  if (surface.image) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={`Page view of ${surface.title}. Click to interact.`}
        className="berth-view relative block w-full overflow-hidden disabled:opacity-80"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width;
          const y = (event.clientY - rect.top) / rect.height;
          onPoint(x, y);
        }}
      >
        <img src={surface.image} alt="" className="absolute inset-0 h-full w-full" />
        {busy && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-line">
            <span className="scan-line block h-full w-1/3 bg-brass" />
          </span>
        )}
      </button>
    );
  }
  return (
    <div className="max-h-[32rem] overflow-auto p-4">
      <h3 className="font-display text-xl italic">{surface.title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-fg">{surface.text.slice(0, 1800)}</p>
      {surface.controls.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {surface.controls.slice(0, 8).map((control) =>
            control.href ? (
              <button
                key={control.href + control.label}
                type="button"
                disabled={busy}
                onClick={() => onFollow(control.href!)}
                className="min-h-11 border border-line px-3 text-left text-sm disabled:opacity-40"
              >
                {control.label}
              </button>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
