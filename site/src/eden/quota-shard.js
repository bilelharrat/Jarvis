// Sharded daily quotas (docs/load-balancing.md, item 3). A VoiceQuota object (worker.js) is one check-and-add for
// everyone who reaches it, so one name for every request is one choke point. Here a stable hash of the asker
// (account, else network) picks one of N objects named `<base>:<i>/<N>`. Each shard keeps the per-asker counters
// whole (one asker always lands on the same shard) and gets ceil(everyone / N) of the shared ceiling, so the shards
// together never pass the total by more than N - 1. N = 1 is the old single object, under its old name.
//
// VOICE_QUOTA_SHARDS (1..64) sets N for every sharded object. Unset: 1 for both (the old single objects). The voice's
// shared ceiling is small (an even split would turn people away early); Help's questions are not a hot object
// (20 a minute per account). When sharded, Help picks the shard by network, so its per-network cap stays exact.

import { sha256Hex } from './key-pool.js';

const MAX_SHARDS = 64;
const DEFAULTS = { daily: 1, 'help-messages': 1 };

/** How many shards `base` uses. */
export function quotaShards(env = {}, base = '') {
  const raw = env && env.VOICE_QUOTA_SHARDS;
  const n = Number(raw);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isInteger(n) && n >= 1) return Math.min(MAX_SHARDS, n);
  return DEFAULTS[base] || 1;
}

/** The asker's shard, 0..n-1: the first 32 bits of SHA-256(asker), mod n. */
export function shardIndex(asker, n) {
  if (!(n > 1)) return 0;
  return parseInt(sha256Hex(String(asker)).slice(0, 8), 16) % n;
}

/** { name, n, index }: the object name to use for this asker. */
export function quotaShard(env, base, asker) {
  const n = quotaShards(env, base);
  if (n <= 1) return { name: base, n: 1, index: 0 };
  const index = shardIndex(asker, n);
  return { name: `${base}:${index}/${n}`, n, index };
}

/** A shard's part of a shared ceiling. */
export const shareOf = (limit, n) => (n > 1 ? Math.ceil(limit / n) : limit);
