"""Thin wrapper around PaddleOCR's Python API.

Lazy-loads the heavy paddleocr/paddlepaddle packages only on first real use (inside
_get_ocr()/_get_orientation_model()), so this module — and main.py, which imports it — stays
importable and its endpoint-shape tests runnable with only the lightweight dependencies in
requirements.txt installed, without needing paddleocr's multi-GB model downloads.
"""
import numpy as np
import cv2

_ocr = None
_orientation_model = None


def _get_ocr():
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR

        _ocr = PaddleOCR(
            lang="fr",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    return _ocr


def _get_orientation_model():
    global _orientation_model
    if _orientation_model is None:
        from paddleocr import DocImgOrientationClassification

        _orientation_model = DocImgOrientationClassification(
            model_name="PP-LCNet_x1_0_doc_ori"
        )
    return _orientation_model


def _decode_image(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")
    return img


def recognize_text(image_bytes: bytes) -> str:
    img = _decode_image(image_bytes)
    results = _get_ocr().predict(img)
    lines = []
    for res in results:
        lines.extend(res.json["res"].get("rec_texts", []))
    return "\n".join(lines)


def detect_orientation(image_bytes: bytes) -> dict:
    img = _decode_image(image_bytes)
    results = _get_orientation_model().predict(img, batch_size=1)
    for res in results:
        data = res.json["res"]
        label = data["label_names"][0]
        score = float(data["scores"][0])
        return {"rotation_degrees": int(label), "confidence": score}
    raise ValueError("PaddleOCR orientation model returned no result")
