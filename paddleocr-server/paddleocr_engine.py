"""Thin wrapper around PaddleOCR's Python API.

Lazy-loads the heavy paddleocr/paddlepaddle packages only on first real use (inside
_get_ocr()/_get_orientation_model()), so this module — and main.py, which imports it — stays
importable and its endpoint-shape tests runnable with only the lightweight dependencies in
requirements.txt installed, without needing paddleocr's multi-GB model downloads.
"""
import threading

import numpy as np
import cv2

# A PaddleOCR/paddlepaddle predictor is a single shared module-global here and is NOT thread-safe,
# while main.py's endpoints are sync `def` and therefore run in Starlette's threadpool — so two
# overlapping requests really do reach predict() at the same time. When they raced, predict()
# raised, /ocr answered HTTP 500, and the TypeScript caller fell straight through to Tesseract for
# that page: on a photographed ID card PaddleOCR returned the clean numbered form fields where
# Tesseract returned line noise. A re-analysis then came back worse than the original triage with no
# error anywhere. These locks serialize inference so a concurrent request queues instead of failing.
#
# One lock PER MODEL, not one global lock: the two models are independent predictors, and a shared
# lock would park a ~2s orientation probe behind a multi-minute OCR pass for no safety gain.
#
# RLock, not Lock: each lock also guards its model's lazy construction, and the inference functions
# the getter while already holding it. A plain Lock would self-deadlock there.
_ocr = None
_ocr_lock = threading.RLock()
_orientation_model = None
_orientation_lock = threading.RLock()


def _get_ocr():
    global _ocr
    with _ocr_lock:
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
    with _orientation_lock:
        if _orientation_model is None:
            from paddleocr import DocImgOrientationClassification

            _orientation_model = DocImgOrientationClassification(
                model_name="PP-LCNet_x1_0_doc_ori"
            )
        return _orientation_model


def models_ready() -> dict:
    """Snapshot of which models are already loaded.

    Deliberately LOCK-FREE: it reads the globals directly instead of taking the inference locks.
    /ready exists to be answerable *during* a multi-minute predict(), and taking the lock here
    would park it behind exactly the work the caller is waiting to hear about. A plain attribute
    read is atomic under the GIL, and a torn answer is harmless anyway — the caller polls.
    """
    return {"ocr": _ocr is not None, "orientation": _orientation_model is not None}


def _decode_image(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")
    return img


def recognize_text(image_bytes: bytes) -> str:
    # Decoding is thread-safe and cheap, so it stays outside the lock — only inference is
    # serialized, which keeps the queue as short as it can be.
    img = _decode_image(image_bytes)
    with _ocr_lock:
        results = _get_ocr().predict(img)
        lines = []
        for res in results:
            lines.extend(res.json["res"].get("rec_texts", []))
    return "\n".join(lines)


def detect_orientation(image_bytes: bytes) -> dict:
    """Return the clockwise rotation that would make this document upright.

    PP-LCNet_x1_0_doc_ori's label is a MEASUREMENT, not an instruction: it says how far the
    document in the image is ALREADY rotated. Correcting a document that sits at 90 therefore
    means rotating it by 270, not by 90. Returning the label unconverted is a real bug this
    service shipped with, and it is an easy one to miss because 180 is its own inverse — only
    the 90 and 270 cases are visibly wrong, and they come out upside down rather than sideways,
    which reads like a flaky classifier instead of a sign error. Measured over 16 real phone
    photos: applying the label left 7/16 upright, applying the conversion below left 15/16 (the
    one remainder is a genuine misclassification, not a convention error).

    `rotation_degrees` is the CORRECTION to apply. `detected_rotation` is the model's raw label,
    returned for diagnostics so the two can never again be silently confused.
    """
    img = _decode_image(image_bytes)
    with _orientation_lock:
        results = _get_orientation_model().predict(img, batch_size=1)
        for res in results:
            data = res.json["res"]
            label = int(data["label_names"][0])
            score = float(data["scores"][0])
            correction = (360 - label) % 360
            return {
                "rotation_degrees": correction,
                "detected_rotation": label,
                "confidence": score,
            }
    raise ValueError("PaddleOCR orientation model returned no result")
