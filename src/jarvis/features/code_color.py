"""Eden Code theme color preference: custom RGB wheel color or preset swatch, saved in prefs.features."""

from __future__ import annotations

import re
from typing import Any

from .. import lang, prefs

PREF = "code_color"
BG_PREF = "code_bg_color"
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_color(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    s = value.strip().lower()
    if s == "":
        return ""
    if re.match(r"^#[0-9a-f]{3}$", s):
        s = f"#{s[1]*2}{s[2]*2}{s[3]*2}"
    return s if _HEX.match(s) else None


prefs.register_feature_pref(PREF, "", clean_color)
prefs.register_feature_pref(BG_PREF, "", clean_color)

ZH = {
    "Color": "颜色",
    "Theme color": "主题颜色",
    "Accent color": "强调色",
    "Background color": "背景颜色",
    "Choose a preset color or spin the RGB wheel.": "选择预设颜色或转动 RGB 色轮。",
    "Choose a background preset or spin the RGB wheel while keeping your accent color.": "选择预设背景色或转动 RGB 色轮，同时保留当前强调色。",
    "Preset colors": "预设颜色",
    "Preset background colors": "预设背景颜色",
    "RGB color wheel": "RGB 色轮",
    "Background RGB color wheel": "背景 RGB 色轮",
    "Brightness": "亮度",
    "Reset": "重置",
    "Eden Blue": "伊甸蓝",
    "Indigo": "靛蓝",
    "Purple": "紫色",
    "Rose": "玫红",
    "Red": "红色",
    "Orange": "橙色",
    "Emerald": "翠绿",
    "Teal": "青色",
    "Black": "纯黑",
    "Sky Glass": "天空玻璃",
    "Midnight": "午夜蓝",
    "Cosmic Indigo": "深空靛",
    "Amethyst": "紫晶",
    "Sunset Rose": "晚霞玫",
    "Warm Amber": "暖琥珀",
    "Forest Pine": "森林松",
    "Slate Grey": "岩灰",
    "Hex color": "十六进制颜色",
    "Red channel": "红色通道",
    "Green channel": "绿色通道",
    "Blue channel": "蓝色通道",
}
lang.add_texts(ZH)


def install(_hub: Any) -> None:
    """Preference-only feature; window UI lives in web/features/code-color.js."""
    return None
