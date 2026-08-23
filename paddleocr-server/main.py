"""Standalone local OCR service backing src/infrastructure/paddleocr-client.ts.

Run with: python main.py
See README.md for one-time dependency setup.
"""
import logging
import threading

from fastapi import FastAPI, UploadFile, File, HTTPException

import paddleocr_engine

logger = logging.getLogger(__name__)

app = FastAPI()


@app.on_event("startup")
def warm_models() -> None:
    """Load the OCR and orientation models in the background, off the request path.

    Both models are created lazily on first use, and that first load is slow (and on a fresh
    machine downloads weights). Paid inside a request, it lands on top of the inference time and
    blows the client's 120s timeout, so the very first document after a restart fails while every
    later one succeeds — a confusing, self-healing symptom.

    This runs in a daemon thread rather than blocking startup on purpose: the TypeScript client
    spawns this process and then polls /health for only ~15s before giving up, so the server must
    start answering immediately. Warming concurrently means the models are usually ready before the
    first real request; if one does arrive mid-warm it simply waits on the same lazy getter it would
    have triggered itself, so this is never worse than not warming.
    """

    def _warm() -> None:
        for name, load in (
            ("orientation", paddleocr_engine._get_orientation_model),
            ("ocr", paddleocr_engine._get_ocr),
        ):
            try:
                load()
                logger.info("Warmed %s model", name)
            except Exception:
                logger.exception("Failed to warm %s model", name)

    threading.Thread(target=_warm, name="warm-models", daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok"}


# These two endpoints are deliberately `def`, NOT `async def`.
#
# recognize_text() and detect_orientation() are synchronous and CPU-bound — a full OCR pass on a
# phone photo runs for tens of seconds. Starlette runs an `async def` endpoint ON THE EVENT LOOP, so
# a blocking call inside one freezes the WHOLE server for its entire duration: no other request is
# accepted, routed or answered, not even /health. That is exactly what happened here — /health
# returned no response at all while an OCR was in flight, the TypeScript client's health probe
# therefore reported "PaddleOCR server is unavailable", and concurrent requests serialized behind
# each other until they hit the client's 120s AbortSignal timeout.
#
# Declaring them `def` makes Starlette run them in its threadpool instead, which keeps the event
# loop free to serve health checks and other requests while inference is running. The cost is that
# `await file.read()` is no longer available, so the upload is read synchronously off the
# underlying spooled file object.
@app.post("/ocr")
def ocr_endpoint(file: UploadFile = File(...)):
    image_bytes = file.file.read()
    try:
        text = paddleocr_engine.recognize_text(image_bytes)
    except Exception as exc:
        logger.exception("OCR failed")
        raise HTTPException(status_code=500, detail=str(exc))
    return {"text": text}


@app.post("/orientation")
def orientation_endpoint(file: UploadFile = File(...)):
    image_bytes = file.file.read()
    try:
        result = paddleocr_engine.detect_orientation(image_bytes)
    except Exception as exc:
        logger.exception("Orientation detection failed")
        raise HTTPException(status_code=500, detail=str(exc))
    return result


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    uvicorn.run(app, host="127.0.0.1", port=8871)
