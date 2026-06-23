"use client";

import { useCallback, useRef, useState } from "react";

export type ToastKind = "success" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let toastSeq = 0;

/** Page-local toast state. Success toasts auto-dismiss; errors persist until
    dismissed (a failure must stay on screen until the user sees it). */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = (toastSeq += 1);
      setToasts((ts) => [...ts, { id, kind, message }]);
      if (kind === "success") {
        timers.current[id] = setTimeout(() => dismiss(id), 3500);
      }
      return id;
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => {
        const tone = t.kind === "success" ? "var(--color-pass)" : "var(--color-fail)";
        return (
          <div
            key={t.id}
            role="status"
            data-testid={`toast-${t.kind}`}
            className="sw-rise pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg px-4 py-3 text-sm shadow-lg backdrop-blur-md"
            style={{
              background: `color-mix(in srgb, ${tone} 14%, var(--color-panel))`,
              border: `1px solid color-mix(in srgb, ${tone} 45%, transparent)`,
              color: "var(--color-ink)",
            }}
          >
            <span className="mt-0.5 shrink-0 text-base leading-none" style={{ color: tone }} aria-hidden="true">
              {t.kind === "success" ? "✓" : "!"}
            </span>
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
