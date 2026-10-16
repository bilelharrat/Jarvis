"""askeden.com's Worker mints the token (site/src/accounts/cloud-token.js) and this service
checks it (auth.py): one token made by the real JavaScript, checked by the real Python."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from eden_cloud.auth import Verifier

SITE = Path(__file__).resolve().parents[2] / "site"
SCRIPT = """
import { mintCloudToken } from './src/accounts/cloud-token.js';
import { bytesToB64 } from './src/accounts/util.js';
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const account = { id: '11111111-1111-4111-8111-111111111111', plan: { name: 'plus', active: true },
  devices: [{ id: 'abcdef0123456789', kind: 'mac', this: true }] };
const { token } = await mintCloudToken({ EDEN_CLOUD_SIGNING_KEY: bytesToB64(pkcs8) }, account);
console.log(JSON.stringify({ token, public: bytesToB64(raw) }));
"""


@pytest.mark.skipif(
    shutil.which("node") is None or not SITE.is_dir(), reason="needs node and site/"
)
def test_a_token_askeden_mints_is_one_eden_cloud_takes():
    out = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT],
        cwd=SITE,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert out.returncode == 0, out.stderr
    made = json.loads(out.stdout)
    user = Verifier(made["public"]).verify(f"Bearer {made['token']}")
    assert (user.account, user.device, user.plan) == (
        "11111111-1111-4111-8111-111111111111",
        "abcdef0123456789",
        "plus",
    )
