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
