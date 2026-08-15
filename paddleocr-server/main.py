"""Standalone local OCR service backing src/infrastructure/paddleocr-client.ts.

Run with: python main.py
See README.md for one-time dependency setup.
"""
from fastapi import FastAPI, UploadFile, File, HTTPException

import paddleocr_engine

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...)):
    image_bytes = await file.read()
    try:
        text = paddleocr_engine.recognize_text(image_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"text": text}


@app.post("/orientation")
async def orientation_endpoint(file: UploadFile = File(...)):
    image_bytes = await file.read()
    try:
        result = paddleocr_engine.detect_orientation(image_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8871)
