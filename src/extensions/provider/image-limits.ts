import type { ModelInputLimits } from "@earendil-works/pi-ai";

/**
 * Resize profile for image-capable proxy models. Pixels stay untouched up to
 * 1568 on the long edge (the ceiling vision APIs downscale to anyway, so image
 * tokens are unchanged); only the encoded payload is capped, which turns a
 * ~3 MB generated PNG into a few hundred KB of JPEG per request.
 */
export const IMAGE_INPUT_LIMITS: ModelInputLimits = {
  images: {
    resize: {
      maxWidth: 1568,
      maxHeight: 1568,
      maxBytes: 1024 * 1024,
      jpegQuality: 85,
    },
  },
};
