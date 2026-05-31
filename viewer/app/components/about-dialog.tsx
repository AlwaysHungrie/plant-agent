"use client";

import { useEffect } from "react";
import { FiX } from "react-icons/fi";
import ReactMarkdown from "react-markdown";

const ABOUT_MD = `# What is this?

Placeholder. Real copy coming soon.`;

export default function AboutDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl rounded-2xl border border-line bg-surface p-8 text-ink shadow-pop rise"
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full p-1.5 text-ink-muted transition hover:bg-surface-2 hover:text-ink"
          aria-label="Close"
        >
          <FiX size={18} />
        </button>
        <div className="prose max-w-none prose-headings:font-display prose-headings:tracking-tight prose-a:text-primary">
          <ReactMarkdown>{ABOUT_MD}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
