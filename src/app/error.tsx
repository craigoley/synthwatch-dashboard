"use client";

// App-level route-segment error boundary. Renders within the root layout, so a render throw in a page
// degrades to an inline recovery panel WITHOUT killing the shell/nav — the user can still reach other routes.
import { ErrorFallback, type RouteError } from "@/components/error-fallback";

export default function Error({ error, reset }: { error: RouteError; reset: () => void }) {
  return <ErrorFallback error={error} reset={reset} />;
}
