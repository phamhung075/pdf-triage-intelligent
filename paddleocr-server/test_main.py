import io
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
