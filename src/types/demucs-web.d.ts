declare module 'demucs-web' {
  export class DemucsProcessor {
    constructor(options: {
      ort: unknown;
      sessionOptions: unknown;
    });
    loadModel(buffer: ArrayBuffer | Uint8Array): Promise<void>;
    separate(left: Float32Array, right: Float32Array): Promise<{
      vocals: { left: Float32Array; right: Float32Array };
    }>;
  }
}
