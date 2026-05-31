"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FiCopy,
  FiChevronLeft,
  FiSend,
  FiCheck,
  FiDroplet,
  FiTrash2,
  FiCreditCard,
  FiExternalLink,
  FiChevronDown,
} from "react-icons/fi";
import { SiSolana } from "react-icons/si";
import { QRCodeSVG } from "qrcode.react";
import { getTokenBalance } from "../actions";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  "https://message-api.dhairyashah98.workers.dev";

const PLANT_NAME = process.env.NEXT_PUBLIC_PLANT_NAME ?? "Tumbuh #001 (Genesis)";
const TWITTER_URL =
  process.env.NEXT_PUBLIC_TWITTER_URL ?? "https://x.com/gettumbuh";

// Wallet assets. Override via NEXT_PUBLIC_ASSETS (JSON array of the same shape).
// usd:true tokens count toward the "Total balance" figure.
type Asset = {
  symbol: string;
  chain: string;
  mint: string;
  usd?: boolean;
};

const DEFAULT_ASSETS: Asset[] = [
  {
    symbol: "USDC",
    chain: "SOL",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usd: true,
  },
  {
    symbol: "JLP",
    chain: "SOL",
    mint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
  },
];

function parseAssets(): Asset[] {
  const raw = process.env.NEXT_PUBLIC_ASSETS;
  if (!raw) return DEFAULT_ASSETS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as Asset[];
  } catch {
    // fall through to default
  }
  return DEFAULT_ASSETS;
}

const ASSETS = parseAssets();

type Contact = {
  id: string;
  name: string;
  wallet: string;
  water_rate_usd_per_l: number;
  flow_rate_ml_per_sec: number;
};

type Config = {
  genesis: { name: string; tagline: string; wallet: string };
  contacts: Contact[];
};

type TabKey = "sent" | "received";

type Message = {
  id: number;
  contact_id: string;
  volume_ml: number;
  cost_usd: number;
  duration_sec: number;
  received: boolean;
  txn: string;
  created_at: string;
};

type MessagesResponse = {
  page: number;
  limit: number;
  total: number;
  results: Message[];
};

const PAGE_SIZE = 20;

class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("GENESIS_JWT");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function hasAnyJwtInStorage(): boolean {
  if (typeof window === "undefined") return false;
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && /jwt/i.test(key)) return true;
  }
  return false;
}

async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) throw new Error("config fetch failed");
  return res.json();
}

async function fetchMessages(
  contactId: string,
  page: number,
): Promise<MessagesResponse> {
  const res = await fetch(
    `${API_BASE}/messages?contact_id=${encodeURIComponent(contactId)}&page=${page}&limit=${PAGE_SIZE}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error("messages fetch failed");
  return res.json();
}

async function postMessage(
  contactId: string,
  volumeMl: number,
): Promise<Message> {
  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ contact_id: contactId, volume_ml: volumeMl }),
  });
  if (res.status === 403) throw new UnauthorizedError();
  if (!res.ok) throw new Error("post failed");
  return res.json();
}

async function patchMessage(
  id: number,
  patch: { received?: boolean; txn?: string },
): Promise<Message> {
  const res = await fetch(`${API_BASE}/messages/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (res.status === 403) throw new UnauthorizedError();
  if (!res.ok) throw new Error("patch failed");
  return res.json();
}

async function deleteMessage(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/messages/${id}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 403) throw new UnauthorizedError();
  if (!res.ok) throw new Error("delete failed");
}

function AuthErrorDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/40 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-ink shadow-pop rise"
      >
        <div className="text-base font-semibold">Not authorized</div>
        <div className="mt-2 text-sm text-ink-muted">
          You are not authorized to perform this action.
        </div>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded-full bg-surface-2 px-4 py-2 text-sm font-medium text-ink transition hover:bg-line"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function short(addr: string) {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function CopyButton({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={`rounded-md p-1.5 text-ink-muted transition hover:bg-surface-2 hover:text-ink ${className}`}
      aria-label="Copy"
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? (
        <FiCheck size={13} className="text-primary" />
      ) : (
        <FiCopy size={13} />
      )}
    </button>
  );
}

function PlantAvatar({ size = 48 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size }}
      className="relative grid place-items-center overflow-hidden rounded-full bg-primary-soft ring-1 ring-primary/20"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/potted-plant.png" alt="" className="h-full w-full object-cover" />
      <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-primary" />
    </div>
  );
}

function PumpAvatar({ size = 40 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size }}
      className="flex items-center justify-center rounded-full bg-surface-2 text-ink-muted ring-1 ring-line"
    >
      <FiDroplet size={size * 0.45} />
    </div>
  );
}

function ContactsView({
  config,
  onPick,
}: {
  config: Config;
  onPick: (c: Contact) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-2 pt-5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink-muted">
        Contacts
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {config.contacts.map((c, i) => (
          <button
            key={c.id}
            onClick={() => onPick(c)}
            style={{ animationDelay: `${i * 50}ms` }}
            className="rise group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2"
          >
            <PumpAvatar />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-medium text-ink">
                  {c.name}
                </div>
                <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary tabnum">
                  ${c.water_rate_usd_per_l.toFixed(2)}/L
                </span>
              </div>
              <div className="truncate text-[11px] text-ink-muted tabnum">
                {short(c.wallet)}
              </div>
            </div>
            <FiChevronLeft
              size={16}
              className="rotate-180 text-line-strong transition group-hover:text-ink-muted"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition ${active
          ? "bg-primary text-primary-ink"
          : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
    >
      {children}
    </button>
  );
}

function MessageBubble({
  msg,
  onPatch,
  onDelete,
  canDelete,
}: {
  msg: Message;
  onPatch: (id: number, patch: { received?: boolean; txn?: string }) => void;
  onDelete: (id: number) => void;
  canDelete: boolean;
}) {
  const [tab, setTab] = useState<TabKey>(msg.received ? "received" : "sent");

  return (
    <div className="group flex w-full flex-col items-stretch gap-1 msg-in">
      <div className="w-full rounded-2xl bg-primary-soft px-3.5 py-2.5 shadow-card ring-1 ring-primary/15">
        <div className="flex items-baseline gap-1.5 text-ink">
          <FiDroplet size={12} className="text-primary" />
          <span className="text-base font-semibold tabnum">
            {msg.volume_ml}
          </span>
          <span className="text-xs text-ink-muted">mL</span>
          {canDelete && (
            <button
              onClick={() => onDelete(msg.id)}
              className="ml-auto rounded p-1 text-ink-muted opacity-0 transition hover:bg-surface-2 hover:text-primary group-hover:opacity-100"
              aria-label="Delete"
              title="Delete"
            >
              <FiTrash2 size={12} />
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
          <span className="tabnum">${msg.cost_usd.toFixed(4)}</span>
          <span className="text-line-strong">·</span>
          <span className="tabnum">{msg.duration_sec.toFixed(1)}s</span>
        </div>

        <div className="mt-2.5 flex items-center gap-0.5 border-t border-primary/15 pt-2">
          <StatusPill active={tab === "sent"} onClick={() => setTab("sent")}>
            sent
          </StatusPill>
          <StatusPill
            active={tab === "received"}
            onClick={() => setTab("received")}
          >
            received
          </StatusPill>
          {msg.txn && (
            <a
              href={`https://solscan.io/tx/${msg.txn}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted transition hover:bg-surface-2 hover:text-ink"
              title="Open transaction on Solscan"
            >
              txn ⟶
            </a>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-muted tabnum">
          {tab === "sent" && (
            <>
              <FiCheck size={11} className="text-primary" />
              request sent
            </>
          )}
          {tab === "received" && (
            <button
              onClick={() => onPatch(msg.id, { received: !msg.received })}
              className="flex items-center gap-1.5 rounded hover:text-ink"
              title="Toggle received"
            >
              {msg.received ? (
                <>
                  <FiCheck size={11} className="text-primary" />
                  confirmed by pump
                </>
              ) : (
                <>
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted" />
                  awaiting confirmation
                </>
              )}
            </button>
          )}
        </div>
      </div>
      <span className="px-1 text-right text-[10px] text-ink-muted">
        {fmtTime(msg.created_at)}
      </span>
    </div>
  );
}

function MessagesView({ contact }: { contact: Contact }) {
  const [ml, setMl] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCanDelete(hasAnyJwtInStorage());
    const onStorage = () => setCanDelete(hasAnyJwtInStorage());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const volume = Number(ml);
  const positive = Number.isFinite(volume) && volume > 0;
  const costUsd = positive ? (volume / 1000) * contact.water_rate_usd_per_l : 0;
  const durationSec = positive ? volume / contact.flow_rate_ml_per_sec : 0;
  const tooShort = positive && durationSec < 1;
  const valid = positive && !tooShort;

  const loadPage = useCallback(
    async (p: number, append: boolean) => {
      setLoading(true);
      try {
        const data = await fetchMessages(contact.id, p);
        setTotal(data.total);
        setMessages((prev) => {
          const combined = append
            ? [...data.results, ...prev]
            : data.results.slice();
          combined.sort((a, b) => a.id - b.id);
          return combined;
        });
        setPage(p);
      } finally {
        setLoading(false);
      }
    },
    [contact.id],
  );

  useEffect(() => {
    loadPage(1, false);
  }, [loadPage]);

  useEffect(() => {
    if (page === 1) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages.length, page]);

  const hasMore = messages.length < total;

  const loadOlder = async () => {
    if (!hasMore || loading) return;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    await loadPage(page + 1, true);
    requestAnimationFrame(() => {
      if (!el) return;
      el.scrollTop = el.scrollHeight - prevHeight;
    });
  };

  const send = async () => {
    if (!valid || sending) return;
    setSending(true);
    try {
      const created = await postMessage(contact.id, volume);
      setMessages((prev) => [...prev, created]);
      setTotal((t) => t + 1);
      setMl("");
    } catch (e) {
      if (e instanceof UnauthorizedError) setAuthError(true);
      else throw e;
    } finally {
      setSending(false);
    }
  };

  const patch = async (
    id: number,
    p: { received?: boolean; txn?: string },
  ) => {
    try {
      const updated = await patchMessage(id, p);
      setMessages((prev) => prev.map((m) => (m.id === id ? updated : m)));
    } catch (e) {
      if (e instanceof UnauthorizedError) setAuthError(true);
      else throw e;
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm("Delete this message?")) return;
    try {
      await deleteMessage(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      if (e instanceof UnauthorizedError) setAuthError(true);
      else throw e;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto bg-[radial-gradient(ellipse_at_top,rgba(207,90,48,0.06),transparent_60%)] px-3 py-4"
      >
        {hasMore && (
          <div className="flex justify-center">
            <button
              onClick={loadOlder}
              disabled={loading}
              className="rounded-full bg-surface-2 px-3 py-1 text-[10px] uppercase tracking-wider text-ink-muted transition hover:bg-line hover:text-ink disabled:opacity-30"
            >
              {loading ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
        {messages.length === 0 && !loading ? (
          <div className="mt-12 flex flex-col items-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-ink-muted">
              <FiDroplet size={20} />
            </div>
            <div className="text-xs text-ink-muted">No messages yet</div>
            <div className="text-[10px] text-ink-muted">
              Request water below to pay the pump
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              onPatch={patch}
              onDelete={remove}
              canDelete={canDelete}
            />
          ))
        )}
      </div>

      <div className="border-t border-line bg-surface/90 p-3 backdrop-blur">
        <div className="flex items-stretch gap-2">
          <div className="relative flex flex-1 items-center">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={ml}
              onChange={(e) => setMl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Water amount"
              disabled={sending}
              className="w-full rounded-full border border-line bg-surface-2 py-2.5 pl-4 pr-12 text-sm text-ink placeholder:text-ink-muted focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
            />
            <span className="pointer-events-none absolute right-4 text-xs font-medium text-ink-muted">
              mL
            </span>
          </div>
          <button
            onClick={send}
            disabled={!valid || sending}
            className="flex items-center justify-center rounded-full bg-primary px-4 text-primary-ink shadow-soft transition hover:bg-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none"
            aria-label="Send"
          >
            <FiSend size={15} />
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-ink-muted">
          <span className={tooShort ? "text-primary" : undefined}>
            {tooShort ? (
              `Min ${Math.ceil(contact.flow_rate_ml_per_sec)} mL (1s pump)`
            ) : valid ? (
              <>
                Cost{" "}
                <span className="font-medium text-ink tabnum">
                  ${costUsd.toFixed(4)}
                </span>
              </>
            ) : (
              "Enter volume in mL"
            )}
          </span>
          <span className="text-ink-muted">
            {valid ? (
              <>
                <span className="tabnum">{durationSec.toFixed(1)}s</span>{" "}
                @ {contact.flow_rate_ml_per_sec} mL/s
              </>
            ) : (
              <>flow {contact.flow_rate_ml_per_sec} mL/s</>
            )}
          </span>
        </div>
      </div>
      {authError && <AuthErrorDialog onClose={() => setAuthError(false)} />}
    </div>
  );
}

function fmtAmount(b: number | null | undefined) {
  if (b == null) return "—";
  return b.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function WalletView({ genesis }: { genesis: Config["genesis"] }) {
  const [balances, setBalances] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all(
      ASSETS.map((a) =>
        getTokenBalance(genesis.wallet, a.mint).then(
          (b) => [a.mint, b] as const,
        ),
      ),
    ).then((entries) => {
      if (!alive) return;
      setBalances(Object.fromEntries(entries));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [genesis.wallet]);

  const total = ASSETS.reduce(
    (sum, a) => (a.usd ? sum + (balances[a.mint] ?? 0) : sum),
    0,
  );
  const formatted = loading
    ? null
    : total.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const [whole, frac] = formatted ? formatted.split(".") : ["—", ""];

  const copy = async () => {
    await navigator.clipboard.writeText(genesis.wallet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-5 pb-6 pt-5">
        {/* Balance hero */}
        <section className="rise">
          <div className="text-[13px] text-ink-muted">Total balance</div>
          <div className="mt-1.5 font-display text-[40px] font-extrabold leading-none tracking-tight tabnum">
            {loading ? (
              <span className="text-ink-muted/50">$—</span>
            ) : (
              <>
                ${whole}
                {frac && <span className="text-ink-muted/70">.{frac}</span>}
              </>
            )}
          </div>
          <div className="mt-2 text-ink-muted">
            <SiSolana size={14} />
          </div>
        </section>

        {/* Two cards: QR + Patron */}
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <div className="flex min-w-0 flex-col items-center justify-center gap-2.5 rounded-2xl border border-line-strong bg-surface p-3 shadow-card sm:p-4">
            <div className="w-full max-w-[140px] rounded-xl border border-line bg-white p-2.5">
              <QRCodeSVG
                value={genesis.wallet}
                size={120}
                bgColor="transparent"
                fgColor="#18181b"
                style={{ width: "100%", height: "auto" }}
              />
            </div>
            <button
              onClick={copy}
              className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[11px] text-ink tabnum transition-colors hover:bg-line"
            >
              <span className="truncate">{short(genesis.wallet)}</span>
              {copied ? (
                <FiCheck size={12} className="shrink-0 text-primary" />
              ) : (
                <FiCopy size={12} className="shrink-0" />
              )}
            </button>
          </div>
          <div className="flex min-w-0 items-center justify-center rounded-2xl border border-line-strong bg-primary-soft/40 p-3 text-center shadow-card sm:p-4">
            <p className="text-[13px] font-semibold leading-snug text-ink sm:text-[14px]">
              Become a Patron by supporting Tumbuh
            </p>
          </div>
        </div>

        {/* Assets */}
        <section className="mt-6">
          <div className="mb-2.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            Assets
          </div>
          <div className="space-y-2">
            {ASSETS.map((a) => (
              <a
                key={a.mint}
                href={`https://solscan.io/token/${a.mint}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-3 rounded-2xl border border-line-strong bg-surface p-3.5 shadow-card transition-colors hover:bg-surface-2"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-soft text-primary ring-1 ring-primary/20">
                  <SiSolana size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink">
                    {a.symbol}
                  </div>
                  <div className="text-[11px] text-ink-muted">on {a.chain}</div>
                </div>
                <div className="text-sm font-semibold tabnum text-ink">
                  {loading ? "—" : fmtAmount(balances[a.mint])}
                </div>
                <FiExternalLink
                  size={15}
                  className="shrink-0 text-line-strong transition-colors group-hover:text-ink-muted"
                />
              </a>
            ))}
          </div>
        </section>

        <a
          href={TWITTER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 block text-center text-[12px] text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          Send us a request to support your asset.
        </a>
      </div>
    </div>
  );
}

type View = "contacts" | "messages" | "wallet";

function PanelHeader({
  view,
  genesis,
  contact,
  onBack,
  onOpenWallet,
  onMinimize,
  draggable,
  dragHandlers,
}: {
  view: View;
  genesis?: Config["genesis"];
  contact: Contact | null;
  onBack: () => void;
  onOpenWallet: () => void;
  onMinimize?: () => void;
  draggable?: boolean;
  dragHandlers?: React.DOMAttributes<HTMLElement>;
}) {
  const isRoot = view === "contacts";
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <header
      {...dragHandlers}
      className={
        "flex h-16 shrink-0 items-center gap-2.5 border-b border-line bg-surface/90 pl-3 pr-12 backdrop-blur select-none md:px-3 " +
        (draggable ? "cursor-grab active:cursor-grabbing" : "")
      }
    >
      {isRoot
        ? onMinimize && (
          <button
            type="button"
            onPointerDown={stop}
            onClick={onMinimize}
            aria-label="Minimize"
            className="grid h-9 w-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <FiChevronDown size={20} />
          </button>
        )
        : (
          <button
            type="button"
            onPointerDown={stop}
            onClick={onBack}
            aria-label="Back"
            className="grid h-9 w-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <FiChevronLeft size={20} />
          </button>
        )}

      {view === "messages" && contact ? (
        <>
          <PumpAvatar size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-ink">
                {contact.name}
              </span>
              <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary tabnum">
                ${contact.water_rate_usd_per_l.toFixed(2)}/L
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="truncate text-[11px] text-ink-muted tabnum">
                {short(contact.wallet)}
              </span>
            </div>
          </div>
          <CopyButton value={contact.wallet} />
        </>
      ) : view === "wallet" ? (
        <>
          <PlantAvatar size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[15px] font-bold tracking-tight text-ink">
              {PLANT_NAME}
            </div>
            <div className="truncate text-[11px] text-ink-muted">
              SVM
            </div>
          </div>
        </>
      ) : (
        <>
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-primary-soft">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/potted-plant.png" alt="" className="h-full w-full object-cover" />
          </span>
          <span className="font-display text-[19px] font-extrabold tracking-tight">
            {PLANT_NAME}
          </span>
          {genesis && (
            <button
              type="button"
              onPointerDown={stop}
              onClick={onOpenWallet}
              aria-label="Open wallet"
              className="ml-auto grid h-10 w-10 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <FiCreditCard size={20} />
            </button>
          )}
        </>
      )}
    </header>
  );
}

export default function Chat({
  onMinimize,
  draggable,
  dragHandlers,
}: {
  onMinimize?: () => void;
  draggable?: boolean;
  dragHandlers?: React.DOMAttributes<HTMLElement>;
} = {}) {
  const [view, setView] = useState<View>("contacts");
  const [contact, setContact] = useState<Contact | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, []);

  let body: React.ReactNode;
  if (!config) {
    body = (
      <div className="flex h-full items-center justify-center text-xs text-ink-muted">
        {error ?? "Loading…"}
      </div>
    );
  } else if (view === "wallet") {
    body = <WalletView genesis={config.genesis} />;
  } else if (view === "messages" && contact) {
    body = <MessagesView contact={contact} />;
  } else {
    body = (
      <ContactsView
        config={config}
        onPick={(c) => {
          setContact(c);
          setView("messages");
        }}
      />
    );
  }

  return (
    <aside className="flex h-full w-full flex-col bg-surface text-ink">
      <PanelHeader
        view={config ? view : "contacts"}
        genesis={config?.genesis}
        contact={contact}
        onBack={() => setView("contacts")}
        onOpenWallet={() => setView("wallet")}
        onMinimize={onMinimize}
        draggable={draggable}
        dragHandlers={dragHandlers}
      />
      <div className="min-h-0 flex-1">{body}</div>
    </aside>
  );
}
