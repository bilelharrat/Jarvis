#!/usr/bin/env bash
# Puts the Eden Creative Suite (its door, /api/creative/*, and its rooms) on the live askeden.com without taking anything
# else live away. askeden.com isn't deployed from main: other sessions deploy from a copy of the live tree with messages
# "live <version> + only my files … Rollback: <version>". So this script:
#
#   1. reads the version that's live now (wrangler deployments list);
#   2. copies the live tree you name (--from: the site/ the live version was deployed from) twice into a fresh folder,
#      and never touches it or anyone's working copy;
#   3. runs the whole site suite on the untouched copy (the baseline), lays the overlay on the other
#      (scripts/creative-overlay/apply.mjs: the suite's new files, and a few exact edits to account.js, index.js,
#      scoped.js, worker.js, chat.js and wrangler.toml), and runs the suite again: no failure the baseline doesn't
#      have, and every creative and rooms test passing;
#   4. builds both with `wrangler deploy --dry-run` and compares the bundles module by module (esbuild's renames
#      normalised): only the overlay's modules may differ;
#   5. only with --go, and only if the live version is still the one you expect (--expect-live), deploys with the house
#      message. The Durable Object migration creative-rooms-v1 (CreativeRoom) is applied by that deploy.
#
#   scripts/deploy-creative-overlay.sh --from ~/edenbuild/<live tree>/site                  # everything but the deploy
#   scripts/deploy-creative-overlay.sh --from … --go --expect-live <version id>              # the owner's OK first
#
# Needs: wrangler logged in (Node 22 at /usr/local/bin for wrangler), Node 20 for the suite (its `node --test test/`),
# python3. The work folder (printed) is kept for a look and is the caller's to delete.

set -euo pipefail

FROM=""
GO=0
EXPECT=""
WORK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --go) GO=1; shift ;;
    --expect-live) EXPECT="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"           # this branch's site/
WRANGLER_NODE_DIR="${WRANGLER_NODE_DIR:-/usr/local/bin}"
TEST_NODE="${TEST_NODE:-/opt/homebrew/bin/node}"
[[ -x "$TEST_NODE" ]] || TEST_NODE="$(command -v node)"
wrangler() { PATH="$WRANGLER_NODE_DIR:$PATH" npx wrangler "$@"; }

[[ -n "$FROM" && -f "$FROM/src/worker.js" && -f "$FROM/wrangler.toml" ]] || { echo "--from must be the live tree's site/ (src/worker.js, wrangler.toml)" >&2; exit 2; }
FROM="$(cd "$FROM" && pwd)"
[[ "$FROM" != "$HERE" ]] || { echo "--from is this branch; name the live tree" >&2; exit 2; }
if [[ $GO -eq 1 && -z "$EXPECT" ]]; then echo "--go needs --expect-live <the version you checked>" >&2; exit 2; fi
MODULES="${NODE_MODULES:-$FROM/node_modules}"
[[ -d "$MODULES/wrangler" ]] || { echo "no node_modules with wrangler at $MODULES (set NODE_MODULES)" >&2; exit 2; }

# 1. what's live now
LIVE="$(cd "$FROM" && wrangler deployments list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=sorted(d, key=lambda x: x.get("created_on","")); print(d[-1]["versions"][0]["version_id"])')"
echo "live now: $LIVE"

# 2. two fresh copies
WORK="${WORK:-$(mktemp -d /tmp/creative-overlay.XXXXXX)}"
mkdir -p "$WORK"
for name in base site; do
  rsync -a --delete --exclude node_modules --exclude .wrangler "$FROM/" "$WORK/$name/"
  ln -sfn "$MODULES" "$WORK/$name/node_modules"
done
echo "work folder: $WORK"

# 3. the suite: baseline, overlay, suite again
(cd "$WORK/base" && "$TEST_NODE" --test test/ > "$WORK/suite-base.txt" 2>&1) || true
node_out="$("$TEST_NODE" "$HERE/scripts/creative-overlay/apply.mjs" "$WORK/site" "$HERE")"
echo "$node_out"
FILES="$(echo "$node_out" | sed -nE 's/^  (.*) \((new|edited)\)$/\1/p' | tr '\n' ' ' | sed 's/ $//')"
(cd "$WORK/site" && "$TEST_NODE" --test test/ > "$WORK/suite-overlay.txt" 2>&1) || true
summary() { grep -E '^# (tests|pass|fail|skipped) ' "$1" | tr '\n' ' '; }
echo "suite, live copy:    $(summary "$WORK/suite-base.txt")"
echo "suite, with overlay: $(summary "$WORK/suite-overlay.txt")"
fails() { grep '^not ok' "$1" | sed -E 's/^not ok [0-9]+ - //; s#/private/tmp/#/tmp/#; s#'"$WORK"'/(base|site)#SITE#' | sort -u; }
NEW="$(comm -13 <(fails "$WORK/suite-base.txt") <(fails "$WORK/suite-overlay.txt"))"
if [[ -n "$NEW" ]]; then echo "failing with the overlay only:"; echo "$NEW"; exit 1; fi
(cd "$WORK/site" && "$TEST_NODE" --test test/creative.test.js test/creative-rooms.test.js > "$WORK/suite-creative.txt" 2>&1) || { echo "the creative tests fail: $WORK/suite-creative.txt"; exit 1; }
echo "creative and rooms:  $(summary "$WORK/suite-creative.txt")"

# 4. the dry runs, compared module by module
(cd "$WORK/base" && wrangler deploy --dry-run --outdir "$WORK/dry-base" > "$WORK/dry-base.log" 2>&1) || { echo "dry run of the live copy failed: $WORK/dry-base.log"; exit 1; }
(cd "$WORK/site" && wrangler deploy --dry-run --outdir "$WORK/dry-site" > "$WORK/dry-site.log" 2>&1) || { echo "dry run with the overlay failed: $WORK/dry-site.log"; exit 1; }
grep -q 'env.CREATIVE_ROOMS (CreativeRoom)' "$WORK/dry-site.log" || { echo "the dry run doesn't bind CREATIVE_ROOMS"; exit 1; }
grep -E 'Total Upload|CREATIVE_ROOMS|EDEN_VIDEOS|dry-run: exiting' "$WORK/dry-site.log"
python3 - "$WORK/dry-base/worker.js" "$WORK/dry-site/worker.js" <<'PY'
import re, sys
def split(p):
    secs, cur, buf = {}, '__prelude__', []
    for line in open(p, encoding='utf-8'):
        m = re.match(r'^// (\S+)\n$', line)
        if m:
            secs[cur] = ''.join(buf); n = m.group(1); k = n; i = 1
            while k in secs or k == cur: i += 1; k = '%s#%d' % (n, i)
            cur, buf = k, []
        buf.append(line)
    secs[cur] = ''.join(buf); return secs
def norm(t):  # esbuild's renames (result2) and the shorthand it spells out (result: result2)
    t = re.sub(r'\b([A-Za-z_$][A-Za-z_$]*?)\d*\b', r'\1', t)
    t = re.sub(r'__esm\(\{\s*"[^"]*"\(\) \{', '', t)
    return re.sub(r'\b([A-Za-z_$][\w$]*): \1\b', r'\1', t)
a, b = split(sys.argv[1]), split(sys.argv[2])
mine = ('src/creative/', 'src/accounts/account.js', 'src/accounts/index.js', 'src/accounts/scoped.js', 'src/worker.js', 'src/eden/chat.js', 'src/voice-config.js')
gone = [k for k in a if k not in b]
other = [k for k in a if k in b and norm(a[k]) != norm(b[k]) and not k.startswith(mine)]
print('bundle: new modules', sorted({k.split('#')[0] for k in b if k not in a}))
print('bundle: changed modules', sorted({k.split('#')[0] for k in a if k in b and norm(a[k]) != norm(b[k])}))
if gone or other:
    print('bundle: UNEXPECTED', {'gone': gone, 'changed': other}); sys.exit(1)
PY

# 5. the deploy, only with --go
if [[ $GO -ne 1 ]]; then
  echo "dry run only. To deploy (with the owner's OK): $0 --from $FROM --go --expect-live $LIVE"
  exit 0
fi
NOW="$(cd "$FROM" && wrangler deployments list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=sorted(d, key=lambda x: x.get("created_on","")); print(d[-1]["versions"][0]["version_id"])')"
if [[ "$NOW" != "$EXPECT" ]]; then echo "live is $NOW now, not $EXPECT: someone deployed since. Copy their tree and run again." >&2; exit 1; fi
MSG="Eden Creative Suite on askeden.com (owner 2026-11-16): the suite's door /api/creative/* (link once, me with plan and usage as askeden.com shows them, Eden turns on the account's own allowance under the app per-ask cap, EVES as askeden.com runs it, B-roll and voice jobs) and editing-together rooms (CreativeRoom, migration creative-rooms-v1). ${FILES}. live ${NOW} + only my files. Rollback: ${NOW}"
(cd "$WORK/site" && wrangler deploy --message "${MSG:0:1000}")
echo "deployed. Rollback: npx wrangler rollback ${NOW} (Cloudflare may refuse a rollback across the creative-rooms-v1 migration: then redeploy $WORK/base with the CREATIVE_ROOMS binding, migration and CreativeRoom export kept)"
