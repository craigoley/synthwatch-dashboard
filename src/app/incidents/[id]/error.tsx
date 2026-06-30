"use client";

import { ErrorFallback, type RouteError } from "@/components/error-fallback";

export default function Error({ error, reset }: { error: RouteError; reset: () => void }) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Couldn’t load this incident"
      detail="This incident’s investigation view hit an error. The incidents list and the rest of the app still work — retry, or head back."
    />
  );
}
