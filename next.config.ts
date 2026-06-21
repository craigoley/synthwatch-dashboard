import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dashboard has no backend of its own anymore — it talks to the C# API via
  // src/lib/api-client.ts (NEXT_PUBLIC_API_BASE_URL). No server-side DB driver to
  // externalize.
  //
  // Artifact screenshots written by the runner may live on arbitrary hosts
  // (blob storage, Azure, etc.). They are rendered with plain <img>, so no
  // next/image remote allow-list is required, but we keep this here as the
  // documented place to lock it down if we switch to next/image later.
  //
  // NOTE: Next 16 removed the built-in `next lint` integration, so there is no
  // `eslint.ignoreDuringBuilds` option anymore — `next build` no longer runs
  // ESLint at all. Linting is enforced solely by the ESLint CI workflow
  // (eslint.yml, --max-warnings 0).
};

export default nextConfig;
