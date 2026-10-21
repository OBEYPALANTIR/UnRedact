import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

// Use real canvas types for PDF.js when tests run outside a browser.
for (const [name, value] of Object.entries({ DOMMatrix, ImageData, Path2D })) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}
