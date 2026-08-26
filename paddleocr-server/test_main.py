import io
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def test_health_returns_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_ocr_endpoint_returns_recognized_text():
    with patch("main.paddleocr_engine.recognize_text", return_value="Hello World"):
        resp = client.post(
            "/ocr", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": "Hello World"}


def test_ocr_endpoint_returns_500_on_engine_error():
    with patch("main.paddleocr_engine.recognize_text", side_effect=ValueError("bad image")):
        resp = client.post(
            "/ocr", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 500
    assert resp.json()["detail"] == "bad image"


def test_orientation_endpoint_returns_rotation_and_confidence():
    with patch(
        "main.paddleocr_engine.detect_orientation",
        return_value={"rotation_degrees": 90, "confidence": 0.95},
    ):
        resp = client.post(
            "/orientation", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 200
    assert resp.json() == {"rotation_degrees": 90, "confidence": 0.95}


def test_orientation_endpoint_returns_500_on_engine_error():
    with patch(
        "main.paddleocr_engine.detect_orientation", side_effect=ValueError("no result")
    ):
        resp = client.post(
            "/orientation", files={"file": ("test.png", io.BytesIO(b"fake-bytes"), "image/png")}
        )
    assert resp.status_code == 500
    assert resp.json()["detail"] == "no result"


class _FakeRes:
    """Minimal stand-in for a PaddleOCR result object (only .json["res"] is read)."""

    def __init__(self, label, score):
        self.json = {"res": {"label_names": [str(label)], "scores": [score]}}


def _orientation_for(label):
    import paddleocr_engine

    with patch.object(paddleocr_engine, "_decode_image", return_value=object()), patch.object(
        paddleocr_engine, "_get_orientation_model"
    ) as get_model:
        get_model.return_value.predict.return_value = [_FakeRes(label, 0.9)]
        return paddleocr_engine.detect_orientation(b"fake-bytes")


def test_orientation_converts_measured_label_into_a_correction():
    # PP-LCNet_x1_0_doc_ori's label says how far the document is ALREADY rotated; the correction
    # is the inverse. Returning the label unconverted put 9 of 16 real photos upside down.
    assert _orientation_for(90)["rotation_degrees"] == 270
    assert _orientation_for(270)["rotation_degrees"] == 90


def test_orientation_leaves_self_inverse_and_zero_labels_alone():
    # 180 is its own inverse and 0 needs nothing — these two are why the sign error stayed hidden.
    assert _orientation_for(180)["rotation_degrees"] == 180
    assert _orientation_for(0)["rotation_degrees"] == 0


def test_orientation_also_reports_the_raw_label_for_diagnostics():
    result = _orientation_for(90)
    assert result["detected_rotation"] == 90
    assert result["confidence"] == 0.9


class _FakeOcrRes:
    """Minimal stand-in for a PaddleOCR OCR result (only .json["res"]["rec_texts"] is read)."""

    def __init__(self, texts):
        self.json = {"res": {"rec_texts": list(texts)}}


class _ConcurrencyTracker:
    """Records how many threads sat inside predict() at the same time."""

    def __init__(self, dwell=0.05):
        self._dwell = dwell
        self._guard = threading.Lock()
        self._active = 0
        self.peak = 0
        self.entries = 0

    def enter(self):
        with self._guard:
            self._active += 1
            self.entries += 1
            self.peak = max(self.peak, self._active)
        time.sleep(self._dwell)
        with self._guard:
            self._active -= 1


def _run_in_threads(call, n=4):
    """Call `call` in n threads, then re-raise anything they raised.

    Patching happens ONCE in the calling thread, never inside the workers: patch.object swaps a
    module global process-wide, so per-thread patching would let one worker restore the original
    while another is still running against it. That made an earlier version of these tests pass
    while half its threads died before ever reaching predict().
    """
    errors = []

    def entry():
        try:
            call()
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=entry) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, "worker threads raised: {}".format(errors)


def test_recognize_text_serializes_concurrent_inference():
    """Two /ocr requests in flight at once must never sit inside predict() together.

    PaddleOCR's predictor is a single shared module-global and is NOT thread-safe, while the
    endpoints in main.py are sync `def` and therefore run in Starlette's threadpool — so
    concurrent requests genuinely land in predict() at the same time. When that raced, /ocr
    returned HTTP 500 and the TypeScript caller silently downgraded that page to Tesseract:
    on a photographed ID card PaddleOCR returned the clean numbered form fields where Tesseract
    returned line noise.
    """
    import paddleocr_engine

    tracker = _ConcurrencyTracker()

    def fake_predict(_img):
        tracker.enter()
        return [_FakeOcrRes(["TEXT"])]

    with patch.object(paddleocr_engine, "_decode_image", return_value=object()), patch.object(
        paddleocr_engine, "_get_ocr", return_value=SimpleNamespace(predict=fake_predict)
    ):
        _run_in_threads(lambda: paddleocr_engine.recognize_text(b"fake-bytes"), n=4)

    assert tracker.entries == 4, "every thread must reach predict() for this test to mean anything"
    assert tracker.peak == 1


def test_detect_orientation_serializes_concurrent_inference():
    """Same non-thread-safe shared predictor, same fix, for the orientation model."""
    import paddleocr_engine

    tracker = _ConcurrencyTracker()

    def fake_predict(_img, batch_size=1):
        tracker.enter()
        return [_FakeRes(0, 0.9)]

    with patch.object(paddleocr_engine, "_decode_image", return_value=object()), patch.object(
        paddleocr_engine, "_get_orientation_model", return_value=SimpleNamespace(predict=fake_predict)
    ):
        _run_in_threads(lambda: paddleocr_engine.detect_orientation(b"fake-bytes"), n=4)

    assert tracker.entries == 4, "every thread must reach predict() for this test to mean anything"
    assert tracker.peak == 1


def test_ocr_and_orientation_do_not_block_each_other():
    """The locks are per-model on purpose: a quick orientation probe must not queue behind OCR.

    A single global inference lock would also make the concurrency tests above pass, so this
    pins down the choice that a shared lock would silently undo.
    """
    import paddleocr_engine

    tracker = _ConcurrencyTracker(dwell=0.15)

    def fake_ocr_predict(_img):
        tracker.enter()
        return [_FakeOcrRes(["TEXT"])]

    def fake_orientation_predict(_img, batch_size=1):
        tracker.enter()
        return [_FakeRes(0, 0.9)]

    with patch.object(paddleocr_engine, "_decode_image", return_value=object()), patch.object(
        paddleocr_engine, "_get_ocr", return_value=SimpleNamespace(predict=fake_ocr_predict)
    ), patch.object(
        paddleocr_engine,
        "_get_orientation_model",
        return_value=SimpleNamespace(predict=fake_orientation_predict),
    ):
        ocr = threading.Thread(target=paddleocr_engine.recognize_text, args=(b"fake-bytes",))
        orientation = threading.Thread(
            target=paddleocr_engine.detect_orientation, args=(b"fake-bytes",)
        )
        ocr.start()
        orientation.start()
        ocr.join()
        orientation.join()

    assert tracker.entries == 2
    assert tracker.peak == 2, "orientation must be able to run while an OCR pass is in flight"


def test_models_ready_reports_which_models_are_loaded():
    import paddleocr_engine

    saved = (paddleocr_engine._ocr, paddleocr_engine._orientation_model)
    try:
        paddleocr_engine._ocr = None
        paddleocr_engine._orientation_model = None
        assert paddleocr_engine.models_ready() == {"ocr": False, "orientation": False}

        paddleocr_engine._ocr = object()
        assert paddleocr_engine.models_ready() == {"ocr": True, "orientation": False}
    finally:
        paddleocr_engine._ocr, paddleocr_engine._orientation_model = saved


def test_models_ready_answers_while_an_inference_holds_the_lock():
    """The whole point of /ready is to be answerable DURING a long OCR pass.

    If models_ready() took the inference lock it would block behind a multi-minute predict(), and
    the client waiting on readiness would stall exactly when it most needs an answer.
    """
    import paddleocr_engine

    holding = threading.Event()
    release = threading.Event()

    def hold_lock():
        with paddleocr_engine._ocr_lock:
            holding.set()
            release.wait(5)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    assert holding.wait(2), "helper thread never acquired the lock"

    answered = threading.Event()

    def probe():
        paddleocr_engine.models_ready()
        answered.set()

    prober = threading.Thread(target=probe)
    prober.start()
    try:
        assert answered.wait(1), "models_ready() blocked behind the inference lock"
    finally:
        release.set()
        holder.join()
        prober.join()


def test_ready_endpoint_reports_warming_until_the_models_are_loaded():
    import paddleocr_engine

    saved = (paddleocr_engine._ocr, paddleocr_engine._orientation_model)
    try:
        paddleocr_engine._ocr = None
        paddleocr_engine._orientation_model = None
        with patch.dict(main._warm_state, {"warming": True}):
            body = client.get("/ready").json()
        assert body["ready"] is False
        assert body["ocr"] is False
        assert body["warming"] is True

        paddleocr_engine._ocr = object()
        paddleocr_engine._orientation_model = object()
        with patch.dict(main._warm_state, {"warming": False}):
            body = client.get("/ready").json()
        assert body["ready"] is True
        assert body["ocr"] is True
        assert body["orientation"] is True
        assert body["warming"] is False
    finally:
        paddleocr_engine._ocr, paddleocr_engine._orientation_model = saved


def test_ready_endpoint_stops_warming_even_if_the_warm_up_failed():
    """A failed warm-up must not leave the client waiting forever.

    warm_models() swallows load errors by design, so `warming: False` with `ocr: False` is the
    signal that nothing more is coming — the client stops waiting and lets the request itself try
    a lazy load rather than blocking out its whole budget.
    """
    import paddleocr_engine

    saved = paddleocr_engine._ocr
    try:
        paddleocr_engine._ocr = None
        with patch.dict(main._warm_state, {"warming": False}):
            body = client.get("/ready").json()
        assert body["ready"] is False
        assert body["warming"] is False
    finally:
        paddleocr_engine._ocr = saved
