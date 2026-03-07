/**
 * Aura sandbox template — pre-baked environment with all tools Aura needs.
 *
 * Build:   npx tsx sandbox/build.ts
 * The resulting template ID goes into E2B_TEMPLATE_ID env var on Vercel.
 */
import { Template } from "e2b";

export const auraTemplate = Template()
  .fromBaseImage("ubuntu:22.04")
  // System tools
  .runCmd("apt-get update -qq")
  .runCmd(
    "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
      "postgresql-client jq ripgrep curl git wget python3 python3-pip " +
      "ca-certificates gnupg lsb-release unzip sudo fuse3 pdftotext"
  )
  // Python packages
  .runCmd("pip3 install --quiet psycopg2-binary google-cloud-bigquery")
  // Node.js 22 LTS
  .runCmd(
    "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && " +
      "DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs"
  )
  // GitHub CLI
  .runCmd(
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | " +
      "dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && " +
      "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | " +
      "tee /etc/apt/sources.list.d/github-cli.list > /dev/null && " +
      "apt-get update -qq && apt-get install -y gh"
  )
  // Google Cloud SDK (gcloud + bq CLI)
  .runCmd(
    "echo 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' | " +
      "tee /etc/apt/sources.list.d/google-cloud-sdk.list > /dev/null && " +
      "curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | " +
      "gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && " +
      "apt-get update -qq && apt-get install -y google-cloud-cli"
  )
  // Vercel CLI
  .runCmd("npm install -g vercel@latest")
  // Claude Code
  .runCmd("npm install -g @anthropic-ai/claude-code")
  // gcsfuse for GCS bucket mounts
  .runCmd(
    "echo 'deb https://packages.cloud.google.com/apt gcsfuse-jammy main' | " +
      "tee /etc/apt/sources.list.d/gcsfuse.list > /dev/null && " +
      "apt-get update -qq && apt-get install -y gcsfuse || true"
  )
  // Working dirs
  .runCmd("mkdir -p /home/user/downloads /home/user/data /home/user/aura")
  .setWorkdir("/home/user");
