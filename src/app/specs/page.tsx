import { redirect } from "next/navigation";

/**
 * The spec catalog was merged INTO /monitors (Reconcile / New monitors / Current monitors on one page). This
 * route redirects there. `?from=catalog` tells the monitors page to expand + scroll to the New monitors
 * section (a server redirect can't carry a #hash, so the intent rides a query param the page reads).
 */
export default function SpecsRedirect() {
  redirect("/monitors?from=catalog");
}
