"use client";

import { useState } from "react";

import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import type { Check } from "@/lib/types";

type Prefill = { fields: Partial<Check>; errors: Record<string, string> } | null;

/**
 * Shared create-monitor surface — used by BOTH the Monitors page and the Status/fleet home so the chat-prefill
 * behaves IDENTICALLY (it's literally the same code, not a copy). The hook owns the open/seed state; each page
 * places the "+ New monitor" button + <MonitorChatInput> where its layout wants and renders <CreateMonitorModal>
 * once. PREFILL-not-CREATE: openPrefilled only SEEDS the form — the human still clicks Create (the modal renders
 * the unchanged MonitorForm in create mode; the parse-intent endpoint already validated the fields).
 */
export function useCreateMonitor() {
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<Prefill>(null);
  const close = () => {
    setCreating(false);
    setPrefill(null);
  };
  return {
    /** Blank create — today's "+ New monitor". */
    openBlank: () => {
      setPrefill(null);
      setCreating(true);
    },
    /** Chat-prefill — seed the create form from a parsed (validated) suggestion; the human reviews + Creates. */
    openPrefilled: (fields: Partial<Check>, errors: Record<string, string>) => {
      setPrefill({ fields, errors });
      setCreating(true);
    },
    modal: { creating, prefill, close },
  };
}

/** The create modal itself — render once per page, fed by useCreateMonitor().modal. */
export function CreateMonitorModal({
  creating,
  prefill,
  close,
}: {
  creating: boolean;
  prefill: Prefill;
  close: () => void;
}) {
  return (
    <Modal
      open={creating}
      onClose={close}
      title={prefill ? "New monitor — from your description" : "New monitor"}
    >
      <MonitorForm
        prefill={prefill?.fields ?? null}
        prefillErrors={prefill?.errors ?? null}
        onDone={close}
        onCancel={close}
      />
    </Modal>
  );
}
