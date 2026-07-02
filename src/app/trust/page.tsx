import { redirect } from "next/navigation";

// §D1 v2: the monitor-trust fleet scorecard moved from this top-level route to a Reports sub-tab. This
// redirect preserves existing /trust bookmarks/links (they land on the Trust tab, no 404). The scorecard
// component itself lives in @/components/trust (TrustScorecard), rendered by /reports.
export default function TrustRedirect() {
  redirect("/reports?tab=trust");
}
