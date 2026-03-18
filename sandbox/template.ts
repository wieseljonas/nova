// Trigger rebuild
/**
 * Nova sandbox template — pre-baked environment with all tools Nova needs.
 *
 * Build:   npx tsx sandbox/build.ts
 * The resulting template ID goes into E2B_TEMPLATE_ID env var on Vercel.
 */
import { Template } from "e2b";

export const auraTemplate = Template()
  .fromImage("ubuntu:22.04")
  // System tools
  .runCmd("sudo apt-get update -qq")
  .runCmd(
    "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
      "postgresql-client jq ripgrep curl git wget python3 python3-pip " +
      "ca-certificates gnupg lsb-release unzip sudo fuse3 poppler-utils"
  )
  // Python packages
  .runCmd("sudo pip3 install --quiet psycopg2-binary google-cloud-bigquery")
  // Node.js 22 LTS
  .runCmd(
    "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && " +
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs"
  )
  // GitHub CLI
  .runCmd(
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | " +
      "sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && " +
      "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | " +
      "sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && " +
      "sudo apt-get update -qq && sudo apt-get install -y gh"
  )
  // Google Cloud SDK (gcloud + bq CLI)
  .runCmd(
    "echo 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' | " +
      "sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list > /dev/null && " +
      "curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | " +
      "sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && " +
      "sudo apt-get update -qq && sudo apt-get install -y google-cloud-cli"
  )
  // Vercel CLI
  .runCmd("sudo npm install -g vercel@latest")
  // Claude Code
  .runCmd("sudo npm install -g @anthropic-ai/claude-code")
  // gcsfuse for GCS bucket mounts (reuse gcloud GPG key for the repo)
  .runCmd(
    "curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | " +
      "sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.asc && " +
      "echo 'deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt gcsfuse-jammy main' | " +
      "sudo tee /etc/apt/sources.list.d/gcsfuse.list > /dev/null && " +
      "sudo apt-get update -qq && sudo apt-get install -y gcsfuse"
  )
  // Prepare GCS mount point and FUSE permissions
  .runCmd("sudo mkdir -p /mnt/gcs && sudo chmod 777 /mnt/gcs && sudo chmod 666 /dev/fuse")
  // Working dirs
  .runCmd("sudo mkdir -p /home/user/downloads /home/user/data /home/user/aura")
  .setWorkdir("/home/user");
