/**
 * Build the Aura e2b sandbox template.
 *
 * Usage:
 *   E2B_API_KEY=e2b_xxx npx tsx sandbox/build.ts [--prod]
 *
 * After a successful build, set E2B_TEMPLATE_ID in Vercel env vars.
 */
import "dotenv/config";
import { Template, defaultBuildLogger } from "e2b";
import { auraTemplate } from "./template.js";

async function main() {
  const isProd = process.argv.includes("--prod");
  const tag = isProd ? "aura-sandbox" : "aura-sandbox-dev";

  console.log(`Building e2b template: ${tag} (${isProd ? "prod" : "dev"})`);

  const result = await Template.build(auraTemplate, tag, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log(`\nBuild complete!`);
  console.log(`Template ID: ${result.templateId}`);
  console.log(`Tag: ${tag}`);
  console.log(`\nNext step: add this to Vercel env vars:`);
  console.log(`  E2B_TEMPLATE_ID=${result.templateId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
