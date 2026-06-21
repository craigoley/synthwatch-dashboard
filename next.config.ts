import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep `pg` (and its optional native deps) out of the bundle so the Node
  // driver loads correctly in the serverless/Fluid Compute runtime.
  serverExternalPackages: ["pg"],
  // Artifact screenshots written by the runner may live on arbitrary hosts
  // (blob storage, Azure, etc.). They are rendered with plain <img>, so no
  // next/image remote allow-list is required, but we keep this here as the
  // documented place to lock it down if we switch to next/image later.
  eslint: {
    // Linting is enforced by the dedicated ESLint CI workflow (eslint.yml) with
    // --max-warnings 0, not by `next build`. Decoupling keeps the production
    // build fast and avoids coupling deploys to lint state.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
