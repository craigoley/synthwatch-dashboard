"use client";

import { ErrorFallback, type RouteError } from "@/components/error-fallback";

export default function Error({ error, reset }: { error: RouteError; reset: () => void }) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Couldn’t load reports"
      detail="The reports view hit an error (often an unexpected report shape). The rest of the app still works — retry, or head back to the dashboard."
    />
  );
}
