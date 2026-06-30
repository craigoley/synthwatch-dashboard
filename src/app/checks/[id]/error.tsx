"use client";

// Segment boundary: a throw in the check-detail view degrades to a contextual panel — other monitors and the
// rest of the app keep working (the "degrade the broken route, not the whole app" point).
import { ErrorFallback, type RouteError } from "@/components/error-fallback";

export default function Error({ error, reset }: { error: RouteError; reset: () => void }) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Couldn’t load this monitor"
      detail="This monitor’s detail view hit an error. Other monitors and the rest of the app still work — retry, or head back to the dashboard."
    />
  );
}
