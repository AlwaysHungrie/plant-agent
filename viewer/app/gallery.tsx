"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  FiChevronLeft,
  FiChevronRight,
  FiRefreshCw,
  FiMessageSquare,
} from "react-icons/fi";
import { FaXTwitter } from "react-icons/fa6";
import { refreshImages } from "./actions";

export type ImageItem = {
  id: number;
  r2_key: string;
  content_type: string;
  size: number;
  created_at: string;
  url: string;
};

const REFRESH_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_REFRESH_INTERVAL_MS ?? 180000,
);

const CAM_LABEL = process.env.NEXT_PUBLIC_CAM_LABEL ?? "CAM 1";
const CAM_SUBLABEL =
  process.env.NEXT_PUBLIC_CAM_SUBLABEL ?? "Plant Brain · BOM 40076";
const PLANT_NAME = process.env.NEXT_PUBLIC_PLANT_NAME ?? "Tumbuh #001 (Genesis)";
const START_DATE = process.env.NEXT_PUBLIC_START_DATE ?? "2026-05-30";
const TWITTER_URL =
  process.env.NEXT_PUBLIC_TWITTER_URL ?? "https://x.com/gettumbuh";

const DAY_MS = 86_400_000;

// Milliseconds elapsed since local midnight.
function msOfDay(d: Date) {
  return (
    ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 +
    d.getMilliseconds()
  );
}

// Plant age in days. Birth date (START_DATE) = Day 1.
function dayNumber(now: Date) {
  const s = new Date(`${START_DATE}T00:00:00`);
  const a = new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((b - a) / DAY_MS)) + 1;
}

// Time remaining until next local midnight, e.g. "4H 12M".
function resetIn(now: Date) {
  const rem = DAY_MS - msOfDay(now);
  const h = Math.floor(rem / 3_600_000);
  const m = Math.floor((rem % 3_600_000) / 60_000);
  return h >= 1 ? `${h}H ${m}M` : `${m}M`;
}

export default function Gallery({ images }: { images: ImageItem[] }) {
  const [idx, setIdx] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null); // client-only clock
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const barRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Tick once a minute for the "Day N" / "reset in" HUD. Set after mount to
  // avoid SSR/client hydration mismatch on time values.
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const onRefresh = useCallback(() => {
    startTransition(async () => {
      await refreshImages();
      router.refresh();
      setIdx(0);
    });
  }, [router]);

  useEffect(() => {
    if (!Number.isFinite(REFRESH_INTERVAL_MS) || REFRESH_INTERVAL_MS <= 0) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") onRefresh();
      }, REFRESH_INTERVAL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        onRefresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [onRefresh]);

  const current = images[idx];
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgLoading = current ? loadedUrl !== current.url : false;

  useEffect(() => {
    if (!current) return;
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) {
      setLoadedUrl(current.url);
    }
  }, [current]);

  if (images.length === 0) {
    return (
      <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 bg-cctv font-mono text-white">
        <span className="flex items-center gap-2 text-[11px] tracking-[0.3em] text-white/70">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" />
          CAM 01 · NO SIGNAL
        </span>
        <button
          onClick={onRefresh}
          disabled={pending}
          className="flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-ink shadow-soft transition hover:bg-primary-hover disabled:opacity-40"
        >
          <FiRefreshCw className={pending ? "animate-spin" : ""} />
          {pending ? "Reconnecting" : "Reconnect"}
        </button>
      </div>
    );
  }

  const canNewer = idx > 0;
  const canOlder = idx < images.length - 1;

  const goNewer = () => canNewer && setIdx((i) => i - 1);
  const goOlder = () => canOlder && setIdx((i) => i + 1);

  const ts = new Date(current.created_at);
  const timeStr = ts.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const isLive = idx === 0;

  // Day is derived from the displayed frame's capture time, not the wallclock,
  // so reviewing an older frame shows the day it was taken.
  const dayLabel = `DAY ${dayNumber(ts)}`;
  const resetLabel = now ? `RESET IN ${resetIn(now)}` : "";

  // Playhead = current frame's position across the captured range.
  // images[0] = newest (live, right edge); images[n-1] = oldest (left edge).
  const lastIdx = images.length - 1;
  const playhead = lastIdx > 0 ? 1 - idx / lastIdx : 1;

  // Map a pointer x onto the frame range (left = oldest, right = newest).
  const seekToX = (clientX: number) => {
    const el = barRef.current;
    if (!el || lastIdx < 1) return;
    const rect = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setIdx(Math.round((1 - f) * lastIdx));
  };

  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekToX(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) seekToX(e.clientX);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onScrubKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goOlder();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goNewer();
    }
  };

  return (
    <div className="relative h-full w-full select-none overflow-hidden bg-cctv">
      <Image
        key={current.url}
        ref={imgRef}
        src={current.url}
        alt={`plant ${current.id}`}
        fill
        sizes="100vw"
        className="object-contain"
        priority
        onLoad={() => setLoadedUrl(current.url)}
      />

      {/* Edge scrims — HUD legibility only */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-linear-to-b from-black/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-linear-to-t from-black/65 to-transparent" />

      {/* Connecting / buffering spinner */}
      {imgLoading && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 font-mono text-white/90">
            <span className="h-9 w-9 animate-spin rounded-full border-2 border-white/25 border-t-primary" />
            <span className="text-[11px] tracking-[0.3em]">BUFFERING…</span>
          </div>
        </div>
      )}

      {/* ── Top HUD ─────────────────────────────────── */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4 sm:p-6 font-mono text-white">
        <div className="flex flex-col gap-1 text-[11px] tracking-widest drop-shadow sm:flex-row sm:items-center sm:gap-2 sm:text-xs">
          <span className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
            <span className="font-semibold">{CAM_LABEL}</span>
          </span>
          <span className="opacity-60">{CAM_SUBLABEL}</span>
        </div>

        <div className="flex flex-col items-end gap-1.5 text-right drop-shadow">
          <span
            className={
              "flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[10px] font-bold tracking-widest " +
              (isLive ? "bg-primary text-white" : "bg-white/15 text-white/90 backdrop-blur-sm")
            }
          >
            {isLive ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-white" /> LIVE
              </>
            ) : (
              <>❚❚ REVIEW</>
            )}
          </span>
          <span className="text-[11px] sm:text-xs tabular-nums tracking-wider opacity-90">
            {dayLabel}
          </span>
          <span className="text-lg sm:text-2xl font-semibold tabular-nums tracking-wide leading-none">
            {timeStr}
          </span>
          <span className="text-[10px] tracking-widest opacity-60">
            {PLANT_NAME}
          </span>
        </div>
      </div>

      {/* ── Bottom controls — scrub-bar styled ──────── */}
      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 font-mono text-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 sm:gap-2">
          {/* Scrub line — playhead across the day (00:00 → 24:00), clickable */}
          <div
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            onPointerCancel={onScrubUp}
            onKeyDown={onScrubKey}
            tabIndex={0}
            className="group relative -my-2 cursor-pointer touch-none py-2 outline-none"
            role="slider"
            aria-label="Seek through frames"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(playhead * 100)}
          >
            <div ref={barRef} className="relative h-1.5 w-full rounded-full bg-white/20">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary/80"
                style={{ width: `${playhead * 100}%` }}
              />
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow ring-2 ring-white/70 transition-transform group-hover:scale-110"
                style={{ left: `${playhead * 100}%` }}
              />
            </div>
          </div>

          {/* Transport controls */}
          <div className="mt-1 flex items-center justify-center gap-2">
            <button
              onClick={goOlder}
              disabled={!canOlder}
              aria-label="Older"
              className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-[12px] font-semibold tracking-wider backdrop-blur transition hover:bg-white/20 disabled:opacity-30"
            >
              <FiChevronLeft size={16} />
              OLDER
            </button>
            <button
              onClick={onRefresh}
              disabled={pending}
              aria-label="Refresh"
              title="Fetch latest"
              className="flex items-center justify-center rounded-full bg-primary px-4 py-2 text-white shadow-soft transition hover:bg-primary-hover disabled:opacity-40"
            >
              <FiRefreshCw size={16} className={pending ? "animate-spin" : ""} />
            </button>
            <button
              onClick={() =>
                window.dispatchEvent(new CustomEvent("tumbuh:open-chat"))
              }
              aria-label="Open chat"
              title="Open chat"
              className="flex items-center justify-center rounded-full border border-white/15 bg-white/10 p-2 text-white backdrop-blur transition hover:bg-white/20"
            >
              <FiMessageSquare size={16} />
            </button>
            <button
              onClick={goNewer}
              disabled={!canNewer}
              aria-label="Newer"
              className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-[12px] font-semibold tracking-wider backdrop-blur transition hover:bg-white/20 disabled:opacity-30"
            >
              NEWER
              <FiChevronRight size={16} />
            </button>
          </div>

          <div className="flex items-center justify-between text-[10px] tracking-widest opacity-60">
            <span className="tabular-nums">{resetLabel}</span>
            <a
              href={TWITTER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition hover:text-white hover:opacity-100"
            >
              Follow for daily updates
              <FaXTwitter size={12} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
