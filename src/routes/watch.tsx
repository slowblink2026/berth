import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/watch")({
  component: WatchPage,
  head: () => ({ meta: [{ title: "Berth · Live" }] }),
});

function dockId(raw: string): string {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `curl${host || "site"}`.slice(0, 80);
  } catch {
    return "";
  }
}

function WatchPage() {
  const [url, setUrl] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("url") ?? "";
  });
  const [input, setInput] = useState(url);
  const [steps, setSteps] = useState<string[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!url) return;
    const id = dockId(url);
    if (!id) return;

    setSteps([]);
    setScreenshot(null);
    setConnected(false);

    const es = new EventSource(`/api/watch?id=${encodeURIComponent(id)}`);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const { label } = JSON.parse(e.data) as { label: string };
        setSteps((prev) => [...prev, label]);
      } catch { /* ignore */ }
    };
    es.onerror = () => setConnected(false);

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/screenshot?id=${encodeURIComponent(id)}`);
        if (res.ok) {
          const blob = await res.blob();
          setScreenshot((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
        }
      } catch { /* network error, skip */ }
    }, 2000);
    pollRef.current = poll;

    return () => {
      es.close();
      clearInterval(poll);
      esRef.current = null;
      pollRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [steps]);

  function go() {
    const trimmed = input.trim();
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (!normalized) return;
    const params = new URLSearchParams({ url: normalized });
    window.history.replaceState(null, "", `?${params}`);
    setUrl(normalized);
    setInput(normalized);
  }

  return (
    <div className="min-h-screen bg-[#101412] text-[#e8e4df] font-[Outfit,sans-serif] flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[#1e2421]">
        <a href="/" className="text-[#8db89a] font-[Fraunces,serif] text-xl font-semibold tracking-tight">
          Berth
        </a>
        <span className="text-[#3a4a3f] select-none">·</span>
        <span className="text-sm text-[#6b7a6f]">Live</span>
        <div className="flex-1 flex gap-2 ml-4">
          <input
            className="flex-1 bg-[#1a2118] border border-[#2a3a2e] rounded-lg px-3 py-1.5 text-sm text-[#e8e4df] placeholder:text-[#4a5a4e] outline-none focus:border-[#4a7a5a]"
            placeholder="https://example.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <button
            onClick={go}
            className="px-4 py-1.5 rounded-lg bg-[#2a4a38] text-[#8db89a] text-sm font-medium hover:bg-[#3a5a48] transition-colors"
          >
            Watch
          </button>
        </div>
        {url && (
          <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${connected ? "bg-[#1a3a28] text-[#5ab87a]" : "bg-[#2a1a1a] text-[#8a5a5a]"}`}>
            {connected ? "live" : "waiting"}
          </span>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Steps panel */}
        <aside className="w-72 shrink-0 border-r border-[#1e2421] flex flex-col">
          <div className="px-4 py-2 text-xs font-medium text-[#4a5a4e] uppercase tracking-wide border-b border-[#1e2421]">
            Steps
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
            {steps.length === 0 && (
              <p className="text-xs text-[#3a4a3f] italic mt-4 px-1">
                {url ? "Waiting for steps…" : "Enter a URL above."}
              </p>
            )}
            {steps.map((label, i) => (
              <div key={i} className="flex items-start gap-2 text-sm py-1">
                <span className="mt-0.5 w-4 h-4 shrink-0 rounded-full bg-[#1a3a28] text-[#5ab87a] text-[10px] flex items-center justify-center font-medium">
                  {i + 1}
                </span>
                <span className="text-[#c8c4bf] leading-snug">{label}</span>
              </div>
            ))}
            <div ref={stepsEndRef} />
          </div>
        </aside>

        {/* Screenshot panel */}
        <main className="flex-1 flex flex-col items-center justify-center overflow-auto p-4">
          {screenshot ? (
            <img
              src={screenshot}
              alt="Browser view"
              className="max-w-full max-h-full rounded-lg border border-[#1e2421] shadow-xl"
              style={{ imageRendering: "auto" }}
            />
          ) : (
            <div className="text-center text-[#3a4a3f]">
              <div className="text-4xl mb-3">◌</div>
              <p className="text-sm">{url ? "Screenshot will appear here." : "Enter a URL to start watching."}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
