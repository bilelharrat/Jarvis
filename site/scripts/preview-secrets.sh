#!/usr/bin/env bash
# The preview of askeden.com (preview.askeden.com, Worker `eden-preview`): put its secrets.
# Run it yourself from site/, after the preview Worker exists (scripts/preview-config.mjs, then
# `npx wrangler deploy -c wrangler.preview.toml`). Wrangler asks for each value; nothing is
# printed or saved anywhere else. EDEN_TOKEN_KEY is made here (32 random bytes), never shown.
#
#   ANTHROPIC_API_KEY      the included AI (console.anthropic.com › API keys)
#   GOOGLE_CLIENT_SECRET   the "Eden web (askeden.com)" client's secret (project eden-510902)
#   STRIPE_SECRET_KEY      Stripe sandbox › Developers › API keys › Secret key (sk_test_…)
#   STRIPE_WEBHOOK_SECRET  Stripe sandbox › Workbench › Webhooks › eden-preview › Signing secret (whsec_…)
#   EDEN_TOKEN_KEY         made here
#
# Hosted Eden's other providers (optional, not in the default list; each turns its models on):
#   scripts/preview-secrets.sh OPENAI_API_KEY GEMINI_API_KEY MOONSHOT_API_KEY
#   OPENAI_API_KEY (platform.openai.com › API keys), GEMINI_API_KEY (aistudio.google.com › API keys;
#   also the Gemini rating), MOONSHOT_API_KEY (platform.moonshot.ai › API keys)
#
# Skip one by pressing Ctrl-C at its prompt and running the script again later; it asks again only
# for the ones you name: scripts/preview-secrets.sh STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:$PATH" # wrangler needs Node 22
node scripts/preview-config.mjs >/dev/null
CONFIG=wrangler.preview.toml

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  names=(ANTHROPIC_API_KEY GOOGLE_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET EDEN_TOKEN_KEY)
fi

for name in "${names[@]}"; do
  if [ "$name" = EDEN_TOKEN_KEY ]; then
    echo "→ EDEN_TOKEN_KEY (made here, not shown)"
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" |
      npx wrangler secret put EDEN_TOKEN_KEY -c "$CONFIG"
  else
    echo "→ $name (paste it, then Return)"
    npx wrangler secret put "$name" -c "$CONFIG"
  fi
done

echo
echo "Secrets now on eden-preview:"
npx wrangler secret list -c "$CONFIG"
