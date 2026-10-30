"""Tests for Eden Secretary ↔ Eden Calendar (`askedencalendar.com`) integration."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import pytest

from jarvis import calendar_kit, edencal, eden_link


def test_edencal_load_config_defaults_to_askedencalendar_com():
    secret = "s" * 40
    cfg = edencal.load_config(
        {
            "EDEN_CALENDAR_LINK_SECRET": secret,
            "EDEN_CALENDAR_USER": "Owner@Example.com",
        }
    )
    assert cfg == edencal.EdenCalConfig(
        url="https://askedencalendar.com",
        secret=secret,
        user="owner@example.com",
    )
    assert edencal.load_config({}) is None


def test_edencal_link_token_matches_worker_hmac_contract():
    cfg = edencal.EdenCalConfig(
        url="https://askedencalendar.com",
        secret="k" * 40,
        user="owner@example.com",
    )
    token = edencal.link_token(cfg, now_s=1700000000)
    body_b64, sig_b64 = token.split(".")
    expected_sig = (
        base64.urlsafe_b64encode(
            hmac.new(cfg.secret.encode("utf-8"), body_b64.encode("ascii"), hashlib.sha256).digest()
        )
        .rstrip(b"=")
        .decode("ascii")
    )
    assert sig_b64 == expected_sig
    padded = body_b64 + "=" * (-len(body_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    assert payload == {
        "sub": "owner@example.com",
        "aud": "eden-calendar",
        "exp": 1700000060,
    }


def test_eden_link_allows_edencal_routes():
    assert ("GET", "/api/chat/edencal/status") in eden_link.ALLOWED
    assert ("POST", "/api/chat/edencal") in eden_link.ALLOWED
