from jarvis.listen import EndpointDetector


def feed_all(detector, values):
    for i, rms in enumerate(values):
        if detector.feed(rms):
            return i
    return None


def test_stops_after_silence_following_speech():
    d = EndpointDetector(silence_seconds=0.5, block_seconds=0.05, calibration_blocks=4)
    values = [0.002] * 4 + [0.2] * 10 + [0.002] * 20
    stop = feed_all(d, values)
    assert d.heard_speech
    assert stop == 4 + 10 + 10 - 1  # ten quiet blocks = 0.5s


def test_short_pauses_do_not_end_the_utterance():
    d = EndpointDetector(silence_seconds=0.5, block_seconds=0.05, calibration_blocks=4)
    values = [0.002] * 4 + [0.2] * 5 + [0.002] * 5 + [0.2] * 5
    assert feed_all(d, values) is None


def test_gives_up_when_nobody_speaks():
    d = EndpointDetector(wait_seconds=1.0, block_seconds=0.05, calibration_blocks=4)
    stop = feed_all(d, [0.002] * 100)
    assert stop == 19
    assert not d.heard_speech


def test_threshold_has_a_floor_in_a_silent_room():
    d = EndpointDetector(calibration_blocks=2)
    feed_all(d, [0.0, 0.0, 0.005])
    assert not d.heard_speech
