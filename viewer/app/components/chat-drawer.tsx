"use client";

import { useEffect, useRef, useState } from "react";
import { FiMessageSquare, FiX } from "react-icons/fi";
import Chat from "./chat";

const WIDTH = 420;
const MARGIN = 24;
const BAR_H = 56;
const TOP_OFFSET = 64;

const PLANT_NAME = process.env.NEXT_PUBLIC_PLANT_NAME ?? "Tumbuh #001 (Genesis)";

export default function ChatDrawer() {
  const [open, setOpen] = useState(false); // mobile drawer
  const [isDesktop, setIsDesktop] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState({ x: MARGIN, y: TOP_OFFSET });
  const [vp, setVp] = useState({ w: 1280, h: 800 });
  const drag = useRef<{
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      setIsDesktop(mq.matches);
      setVp({ w: window.innerWidth, h: window.innerHeight });
    };
    sync();
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  // Opened from the gallery transport bar's chat button.
  useEffect(() => {
    const onOpen = () => {
      if (isDesktop) setCollapsed(false);
      else setOpen(true);
    };
    window.addEventListener("tumbuh:open-chat", onOpen);
    return () => window.removeEventListener("tumbuh:open-chat", onOpen);
  }, [isDesktop]);

  const panelW = Math.min(WIDTH, vp.w - 2 * MARGIN);
  const blockW = panelW;
  const height = collapsed ? BAR_H : vp.h - TOP_OFFSET - MARGIN;
  const maxLeft = Math.max(MARGIN, vp.w - blockW - MARGIN);
  const maxTop = Math.max(TOP_OFFSET, vp.h - height - MARGIN);
  const left = Math.min(Math.max(MARGIN, pos.x), maxLeft);
  const top = Math.min(Math.max(TOP_OFFSET, pos.y), maxTop);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = {
      dx: e.clientX - left,
      dy: e.clientY - top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3)
      d.moved = true;
    setPos({
      x: Math.min(Math.max(MARGIN, e.clientX - d.dx), maxLeft),
      y: Math.min(Math.max(TOP_OFFSET, e.clientY - d.dy), maxTop),
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    movedRef.current = drag.current?.moved ?? false;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const dragHandlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };

  // ── Desktop ──
  if (isDesktop) {
    if (collapsed) {
      return (
        <div
          {...dragHandlers}
          style={{ left, top, width: blockW, height: BAR_H }}
          className="fixed z-50 flex select-none items-center gap-2.5 overflow-hidden rounded-full border border-line-strong bg-bg px-3 shadow-pop cursor-grab active:cursor-grabbing"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-primary-soft">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/potted-plant.png" alt="" className="h-full w-full object-cover" />
          </span>
          <span className="truncate font-display text-[17px] font-extrabold tracking-tight text-ink">
            {PLANT_NAME}
          </span>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (!movedRef.current) setCollapsed(false);
            }}
            aria-label="Open chat"
            className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-primary-ink shadow-soft transition hover:bg-primary-hover active:scale-95"
          >
            <FiMessageSquare size={18} />
          </button>
        </div>
      );
    }
    return (
      <div
        style={{ left, top, width: panelW, height }}
        className="fixed z-50 flex flex-col overflow-hidden rounded-[2.25rem] border border-line-strong bg-bg shadow-pop"
      >
        <Chat
          draggable
          dragHandlers={dragHandlers}
          onMinimize={() => setCollapsed(true)}
        />
      </div>
    );
  }

  // ── Mobile: full-screen drawer (opened from gallery transport bar) ──
  return (
    <>
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-cctv/50 backdrop-blur-sm transition-opacity ${open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
      />

      <div
        className={
          "fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-bg transition-transform duration-300 " +
          (open ? "translate-x-0" : "translate-x-full")
        }
      >
        <button
          onClick={() => setOpen(false)}
          className="absolute right-3 top-3 z-10 rounded-full p-1.5 text-ink-muted transition hover:bg-surface-2 hover:text-ink"
          aria-label="Close"
        >
          <FiX size={18} />
        </button>
        <Chat onMinimize={() => setOpen(false)} />
      </div>
    </>
  );
}
