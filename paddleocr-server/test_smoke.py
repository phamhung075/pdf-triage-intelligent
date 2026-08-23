import io

import pytest
from PIL import Image, ImageDraw


@pytest.mark.skip(
    reason=(
        "Requires requirements-inference.txt installed and downloads PaddleOCR models on "
        "first run (network required) — slow. Run manually: comment out this skip decorator, "
        "then `pytest test_smoke.py -v`."
    )
)
def test_recognizes_real_text_from_a_rendered_image():
    import paddleocr_engine

    img = Image.new("RGB", (400, 150), color="white")
    draw = ImageDraw.Draw(img)
    draw.text((20, 50), "HELLO WORLD", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")

    text = paddleocr_engine.recognize_text(buf.getvalue())
    assert "HELLO" in text.upper()
