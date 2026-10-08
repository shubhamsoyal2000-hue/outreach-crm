"use client";

import { useFormStatus } from "react-dom";

/** A submit button that says it's working, for actions that take a while. */
export function SubmitButton({ children, pendingText = "Working… this can take up to a minute", disabled }: { children: React.ReactNode; pendingText?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}
