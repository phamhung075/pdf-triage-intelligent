// Pure page geometry for placing one photographed document onto a PDF page. Zero I/O.
//
// Archived photos share the shelf with ordinary PDFs, so they are laid out on a real A4 page rather
// than on a page cut to the photo's own pixel dimensions: a page whose size varies per camera
// prints unpredictably and looks wrong next to every other document in the archive.

// A4 in PostScript points (1/72"), the unit pdf-lib works in.
export const A4_SHORT_SIDE = 595.28;
export const A4_LONG_SIDE = 841.89;

export interface PagePlacement {
  pageWidth: number;
  pageHeight: number;
  drawWidth: number;
  drawHeight: number;
  x: number;
  y: number;
}

// Fits an image onto an A4 page, preserving its aspect ratio and centring it.
//
// The page takes the orientation of the image, so a landscape photo lands on a landscape page
// instead of being letterboxed into a portrait one and wasting half the sheet. The image is scaled
// to fit inside the page (never cropped, never stretched, and never enlarged beyond the page), so
// whichever dimension is proportionally larger becomes the limiting one.
export function fitImageToA4(imageWidth: number, imageHeight: number): PagePlacement {
  // A degenerate or unreadable size would otherwise produce NaN offsets and a corrupt page; fall
  // back to a full portrait page so the document is still archived rather than lost.
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    return {
      pageWidth: A4_SHORT_SIDE,
      pageHeight: A4_LONG_SIDE,
      drawWidth: A4_SHORT_SIDE,
      drawHeight: A4_LONG_SIDE,
      x: 0,
      y: 0,
    };
  }

  const landscape = imageWidth > imageHeight;
  const pageWidth = landscape ? A4_LONG_SIDE : A4_SHORT_SIDE;
  const pageHeight = landscape ? A4_SHORT_SIDE : A4_LONG_SIDE;

  const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;

  return {
    pageWidth,
    pageHeight,
    drawWidth,
    drawHeight,
    x: (pageWidth - drawWidth) / 2,
    y: (pageHeight - drawHeight) / 2,
  };
}
