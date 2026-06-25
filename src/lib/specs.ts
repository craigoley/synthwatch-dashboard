import type { SpecCatalogEntry, Tag } from "@/lib/types";
import type { CreateCheckInput } from "@/lib/schemas";

/**
 * The synthetic flow_name a spec activates with: the spec file's basename minus `.spec.ts`
 * (e.g. monitors/wegmans/search-product.spec.ts → search-product). The runner IGNORES flow_name
 * when spec_path is set, but the browser_needs_flow DB constraint still requires it non-null — so
 * activation derives this value and locks it. Mirrors the runner's flowNameFor().
 */
export function flowNameFor(specPath: string): string {
  const base = specPath.split("/").pop() ?? specPath;
  return base.replace(/\.spec\.ts$/, "");
}

/**
 * The prefill an Unmonitored catalog row carries into MonitorForm's activation mode. Splits the
 * manifest spec into LOCKED identity (source_key / spec_path / kind / synthetic flow_name) and the
 * editable/ask fields (name, target, interval, tags). target may be null — the manifest can omit it
 * and the form then ASKS (target_url is validation-required even though the spec self-navigates).
 */
export interface ActivationContext {
  sourceKey: string;
  specPath: string;
  flowName: string;
  name: string;
  target: string | null;
  intervalSeconds: number;
  tags: Tag[];
}

/** Build the activation prefill from a catalog row (manifest tags → key:value via "k:v" or bare "k"). */
export function activationFrom(entry: SpecCatalogEntry): ActivationContext {
  return {
    sourceKey: entry.source_key,
    specPath: entry.spec_path,
    flowName: flowNameFor(entry.spec_path),
    name: entry.name,
    target: entry.target,
    intervalSeconds: entry.suggested_interval_seconds ?? 300,
    tags: (entry.tags ?? []).map(parseManifestTag),
  };
}

/** A manifest tag is "key:value" (or a bare "key" → value "true"), lowercased to match the tag store. */
function parseManifestTag(raw: string): Tag {
  const i = raw.indexOf(":");
  const key = (i >= 0 ? raw.slice(0, i) : raw).trim().toLowerCase();
  const value = (i >= 0 ? raw.slice(i + 1) : "true").trim().toLowerCase() || "true";
  return { key, value };
}

/** The locked spec-binding fields merged into a create payload at activation submit. */
export function activationPayload(ctx: ActivationContext): Pick<CreateCheckInput, "source_key" | "spec_path"> {
  return { source_key: ctx.sourceKey, spec_path: ctx.specPath };
}
