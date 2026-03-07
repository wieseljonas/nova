/**
 * Build Aura e2b sandbox template
 * Run: E2B_API_KEY=e2b_xxx /usr/bin/node sandbox/build.cjs [--prod]
 */
const isProd = process.argv.includes('--prod');
const tag = isProd ? 'aura-sandbox' : 'aura-sandbox-dev';

// Use CJS version of e2b
const e2b = require('../node_modules/e2b/dist/index.js');
const { Template, defaultBuildLogger } = e2b;

async function main() {
  const auraTemplate = Template()
    .fromBaseImage('ubuntu:22.04')
    .runCmd('apt-get update -qq')
    .runCmd(
      'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'postgresql-client jq ripgrep curl git wget gnupg lsb-release ' +
      'ca-certificates unzip sudo fuse3 poppler-utils python3 python3-pip'
    )
    .runCmd('pip3 install --quiet --no-cache-dir psycopg2-binary google-cloud-bigquery')
    .runCmd('curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs')
    .runCmd(
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && ' +
      'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && ' +
      'apt-get update -qq && apt-get install -y gh'
    )
    .runCmd(
      'echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list > /dev/null && ' +
      'curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && ' +
      'apt-get update -qq && apt-get install -y google-cloud-cli'
    )
    .runCmd('npm install -g vercel@latest @anthropic-ai/claude-code')
    .runCmd(
      'echo "deb https://packages.cloud.google.com/apt gcsfuse-jammy main" | tee /etc/apt/sources.list.d/gcsfuse.list > /dev/null && ' +
      'apt-get update -qq && apt-get install -y gcsfuse || true'
    )
    .runCmd('mkdir -p /home/user/downloads /home/user/data /home/user/aura')
    .setWorkdir('/home/user');

  console.log(`Building e2b template: ${tag}`);
  console.log('This will take 5-10 minutes...\n');

  const result = await Template.build(auraTemplate, tag, {
    cpuCount: 2,
    memoryMB: 1024,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log('\nBuild complete!');
  console.log('Template ID:', result.templateId);
  console.log(`\nAdd to Vercel env vars:\n  E2B_TEMPLATE_ID=${result.templateId}`);
}

main().catch(err => { console.error(err); process.exit(1); });
