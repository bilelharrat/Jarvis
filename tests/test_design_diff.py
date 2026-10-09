"""The perceptual comparison behind Eden Code's "Match a design" (design_diff.py): pure
numpy, on pictures made in the test."""

import base64

import numpy as np
import pytest

from jarvis import design_diff


def page(h=200, w=320, header=(29, 78, 216), body=(250, 250, 250), header_rows=40):
    img = np.empty((h, w, 3), dtype=np.uint8)
    img[:] = body
    img[:header_rows] = header
    img[80:150, 40:140] = (60, 60, 60)  # a card
    return img


def test_the_same_picture_scores_full_marks_and_paints_no_heat():
    a = page()
    result = design_diff.compare(a, a.copy())
    assert result.score == pytest.approx(1.0, abs=1e-6)
    assert max(result.heat) == 0
    assert len(result.heat) == result.rows * result.cols


def test_a_page_that_differs_scores_lower_and_says_where():
    design = page()
    built = page(header=(220, 38, 38))  # the header came out red
    built[80:150, 200:300] = (60, 60, 60)  # and the card on the right instead of the left
    built[80:150, 40:140] = (250, 250, 250)
    result = design_diff.compare(design, built)
    assert 0.3 < result.score < 0.97
    assert result.colour < 0.99 and result.structure < 0.99
    regions = dict(result.regions)
    assert result.regions[0][0] in ("middle left", "middle right", "the centre")  # the card moved
    assert regions["top left"] > 0.1 and regions["top right"] > 0.1  # the header's colour
    untouched = dict(design_diff.compare(design, design.copy()).regions)
    assert untouched["top left"] < 0.01
    # The heat-map is hottest where the card moved.
    grid = np.array(result.heat).reshape(result.rows, result.cols)
    assert grid.max() > 60
    # Closer is better: a page with only the header's colour wrong scores higher.
    nearer = design_diff.compare(design, page(header=(220, 38, 38)))
    assert nearer.score > result.score


def test_a_shift_of_a_pixel_is_forgiven():
    design = page()
    shifted = np.roll(design, 1, axis=1)
    assert design_diff.compare(design, shifted).score > 0.95


def test_pictures_are_read_only_when_their_bytes_match_their_size():
    img = page(20, 30)
    data = base64.b64encode(img.tobytes()).decode()
    assert design_diff.decode_rgb(data, 30, 20).shape == (20, 30, 3)
    for bad in [
        (data, 31, 20),
        ("not base64!", 30, 20),
        (data, 0, 20),
        (data, 4000, 4000),
        (None, 30, 20),
        (data, "x", 20),
    ]:
        with pytest.raises(ValueError):
            design_diff.decode_rgb(*bad)
    with pytest.raises(ValueError):
        design_diff.compare(page(20, 30), page(20, 31))
    with pytest.raises(ValueError):
        design_diff.compare(page(4, 4), page(4, 4))  # smaller than the window


def test_large_pictures_are_shrunk_first():
    big = np.zeros((600, 1000, 3), dtype=np.uint8)
    assert design_diff.shrink(big).shape[1] <= design_diff.COMPARE_SIDE
    small = np.zeros((100, 120, 3), dtype=np.uint8)
    assert design_diff.shrink(small).shape == (100, 120, 3)


def test_the_note_for_a_refinement_round_gives_the_score_and_the_worst_regions():
    design = page()
    result = design_diff.compare(design, page(header=(220, 38, 38)))
    text = design_diff.feedback(result, 2, 3, (1440, 900))
    assert text.startswith("Design match, round 2 of 3:")
    assert design_diff.percent(result.score) in text and "1440×900" in text
    assert "top" in text and "attached picture is the page" in text
    same = design_diff.compare(design, design.copy())
    assert "No region stands out" in design_diff.feedback(same, 1, 3, (10, 10))
