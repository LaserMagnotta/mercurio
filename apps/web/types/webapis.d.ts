// ADR-021 — minimal typings for the browser APIs the in-page QR scanner uses
// that TypeScript's stock lib.dom does not yet ship: the Barcode Detection API
// and the camera `torch` capability/constraint. Only the surface the scanner
// actually touches is declared, kept deliberately small. Script-scoped (no
// import/export) so the interfaces merge into the global lib.dom types.

interface BarcodeDetectorOptions {
  formats?: string[];
}

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  static getSupportedFormats(): Promise<string[]>;
  detect(source: CanvasImageSource | ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface Window {
  // Absent on many browsers (Firefox, Safari, Chrome on Windows/Linux): always
  // feature-detect before use — the scanner does (ADR-021 §2).
  BarcodeDetector?: typeof BarcodeDetector;
}

// The torch (flashlight) is a non-standard but widely shipped camera control:
// exposed by getCapabilities() and set through an `advanced` constraint.
interface MediaTrackCapabilities {
  torch?: boolean;
}

interface MediaTrackConstraintSet {
  torch?: boolean;
}
