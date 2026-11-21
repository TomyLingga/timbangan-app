"use client";

import { useState, type ReactNode } from "react";

import { TextAreaField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { useAction } from "@/hooks/use-form";

interface ActionSheetProps {
  title: string;
  description?: string;
  submitLabel: string;
  /** Shows a text box for a reason or note under this label. */
  reasonLabel?: string;
  /** Message when the reason is left empty; without it the reason is optional. */
  reasonRequired?: string;
  children?: ReactNode;
  returnFocus?: () => void;
  onClose: () => void;
  /** Runs the action. Returns the text to show when it failed, or null when it is done. */
  onConfirm: (reason: string) => Promise<string | null>;
}

/** Confirmation of one status change (send, close, cancel, approve, reject), with a reason when it needs one. */
export function ActionSheet({
  title,
  description,
  submitLabel,
  reasonLabel,
  reasonRequired,
  children,
  returnFocus,
  onClose,
  onConfirm,
}: ActionSheetProps) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const action = useAction();

  async function handleSubmit() {
    setFailure(null);
    if (reasonLabel && reasonRequired && !reason.trim()) {
      setReasonError(reasonRequired);
      return;
    }
    const outcome = await action.run(() => onConfirm(reason.trim()));
    const message = outcome.ok ? outcome.value : "Terjadi kesalahan yang tidak dikenal. Coba lagi.";
    if (message) setFailure(message);
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={title}
      description={description}
      submitLabel={submitLabel}
      pending={action.pending}
      error={failure}
      onSubmit={handleSubmit}
      returnFocus={returnFocus}
    >
      {children}
      {reasonLabel ? (
        <TextAreaField
          label={reasonLabel}
          name="reason"
          optional={!reasonRequired}
          value={reason}
          onChange={(value) => {
            setReason(value);
            setReasonError(undefined);
          }}
          error={reasonError}
        />
      ) : null}
    </FormSheet>
  );
}
