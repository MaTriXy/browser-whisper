/**
 * Transcriber.ts — Public API
 *
 * Usage:
 *   const transcriber = new BrowserWhisper({ model: 'whisper-base', language: 'en' })
 *
 *   // Async-iterable style:
 *   for await (const segment of transcriber.transcribe(file)) {
 *     console.log(segment.text)
 *   }
 *
 *   // Collect everything at once:
 *   const segments = await transcriber.transcribe(file).collect()
 *
 *   // Callback style (works simultaneously with iteration):
 *   transcriber.transcribe(file, { onSegment: (s) => appendToUI(s) })
 */

import { Bridge } from './lib/bridge.js';
import { BrowserWhisperError } from './errors.js';
import type {
    MainThreadMessage,
    TranscriptSegment,
    TranscribeOptions,
    TranscribeProgress,
    ASRModel,
    DownloadModelOptions,
    QuantizationType,
} from './types.js';

import WhisperWorker from './workers/whisper-worker.ts?worker&inline';

// ---------------------------------------------------------------------------
// BrowserWhisper (main entry point for consumers)
// ---------------------------------------------------------------------------

/**
 * The core entry point for the browser-whisper library.
 * It manages the lifecycle of the Web Workers and exposes a simple API
 * for transcribing audio files directly in the browser via WebGPU and WebCodecs.
 */
export class BrowserWhisper {
    private readonly defaultOptions: TranscribeOptions;
    private whisperWorker: Worker | null = null;

    /**
     * @param options Global options to apply to all transcriptions instantiated by this class.
     */
    constructor(options: TranscribeOptions = {}) {
        this.defaultOptions = options;
    }

    /**
     * Starts transcribing a given audio or video File.
     * 
     * Internally, this boots up two Web Workers:
     * 1. A Decoder Worker (using WebCodecs/MediaBunny to decode the file)
     * 2. An ASR Worker (using Transformers.js/WebGPU to run inference)
     * 
     * The workers communicate with each other via a zero-copy MessageChannel,
     * entirely bypassing the main UI thread to prevent blocking.
     *
     * @param file The audio or video file to transcribe.
     * @param runtimeOptions Options that merge with and override the constructor options for this specific file.
     * @returns A TranscribeStream that implements AsyncIterable, allowing for `for await` loops.
     */
    transcribe(file: File, runtimeOptions: TranscribeOptions = {}): TranscribeStream {
        const mergedOptions = { ...this.defaultOptions, ...runtimeOptions };
        return new TranscribeStream(file, mergedOptions, this.getWhisperWorker());
    }

    /**
     * Starts transcribing already-decoded mono 16-kHz PCM samples.
     * Useful with browser VAD libraries that already emit Whisper-ready audio.
     */
    transcribePCM(samples: Float32Array, runtimeOptions: TranscribeOptions = {}): TranscribePCMStream {
        const mergedOptions = { ...this.defaultOptions, ...runtimeOptions };
        return new TranscribePCMStream(samples, mergedOptions, this.getWhisperWorker());
    }

    /**
     * Explicitly downloads, stores, and verifies a model ahead of transcription.
     *
     * Model files are stored in OPFS via the worker's transformers.js custom
     * cache. Existing Cache API entries are migrated into OPFS on first access.
     */
    async downloadModel(options: ASRModel | DownloadModelOptions = {}): Promise<void> {
        const runtimeOptions = typeof options === 'string' ? { model: options } : options;
        const mergedOptions: DownloadModelOptions = {
            model: this.defaultOptions.model,
            quantization: this.defaultOptions.quantization,
            onProgress: this.defaultOptions.onProgress,
            ...runtimeOptions,
        };

        await this.loadModel(
            mergedOptions.model ?? 'whisper-tiny',
            mergedOptions.quantization,
            mergedOptions.onProgress,
        );
    }

    /**
     * Terminates the reusable Whisper worker owned by this instance.
     * Call this when the transcriber will not be used again.
     */
    dispose(): void {
        this.whisperWorker?.terminate();
        this.whisperWorker = null;
    }

    private getWhisperWorker(): Worker {
        if (!this.whisperWorker) {
            this.whisperWorker = new WhisperWorker();
        }

        return this.whisperWorker;
    }

    private loadModel(
        model: ASRModel,
        quantization?: QuantizationType,
        onProgress?: (event: TranscribeProgress) => void,
    ): Promise<void> {
        const worker = this.getWhisperWorker();

        return new Promise((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<MainThreadMessage>) => {
                const message = event.data;

                if (message.type === 'ready') {
                    resolve();
                    return;
                }

                if (message.type === 'progress') {
                    onProgress?.(message.event);
                    return;
                }

                if (message.type === 'error') {
                    reject(new BrowserWhisperError(message.message));
                }
            };

            worker.onerror = (event) => {
                reject(new BrowserWhisperError(event.message ?? 'Whisper worker failed.'));
            };

            worker.postMessage({ type: 'init', model, quantization });
        });
    }
}

// ---------------------------------------------------------------------------
// TranscribeStream — implements AsyncIterable<TranscriptSegment>
// ---------------------------------------------------------------------------

/**
 * A stream representing an active transcription process.
 * 
 * It implements `AsyncIterable<TranscriptSegment>`, meaning you can iterate over
 * it using a `for await (const segment of stream)` loop. The loop will suspend
 * natively while waiting for the GPU to emit the next chunk of text.
 * 
 * Alternatively, it accepts standard event callbacks via its constructor options.
 */
export class TranscribeStream implements AsyncIterable<TranscriptSegment> {
    private readonly file: File;
    private readonly options: TranscribeOptions;
    private readonly whisperWorker: Worker | undefined;

    // Internal async queue state for the generator
    private readonly queue: TranscriptSegment[] = [];
    private doneFlag = false;
    private error: Error | undefined;

    // The resolver function to wake up the `for await` loop when a new item arrives
    private notify: (() => void) | null = null;

    // The Bridge instance controlling the underlying Web Workers. Created lazily.
    private bridge: Bridge | null = null;

    constructor(file: File, options: TranscribeOptions = {}, whisperWorker?: Worker) {
        this.file = file;
        this.options = options;
        this.whisperWorker = whisperWorker;
    }

    // ---------------------------------------------------------------------------
    // AsyncIterable implementation
    // ---------------------------------------------------------------------------

    async *[Symbol.asyncIterator](): AsyncGenerator<TranscriptSegment> {
        // Start the pipeline on first iteration
        await this.startBridge();

        // Yield segments as they arrive
        while (true) {
            if (this.queue.length > 0) {
                yield this.queue.shift()!;
            } else if (this.error) {
                throw this.error;
            } else if (this.doneFlag) {
                return;
            } else {
                // Wait for the next segment, done signal, or error
                await new Promise<void>((resolve) => {
                    this.notify = resolve;
                });
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Collect all segments into an array.
     * Convenient alternative to `for await`.
     *
     * @example
     * const segments = await transcriber.transcribe(file).collect()
     */
    async collect(): Promise<TranscriptSegment[]> {
        const segments: TranscriptSegment[] = [];
        for await (const seg of this) segments.push(seg);
        return segments;
    }

    /**
     * Cancel the transcription and terminate the underlying workers.
     */
    cancel(): void {
        this.bridge?.terminate();
        this.doneFlag = true;
        this.wakeUp();
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private async startBridge(): Promise<void> {
        const { options } = this;

        this.bridge = new Bridge(
            {
                onSegment: (segment: TranscriptSegment) => {
                    this.queue.push(segment);
                    options.onSegment?.(segment);
                    this.wakeUp();
                },
                onProgress: (event: TranscribeProgress) => {
                    options.onProgress?.(event);
                },
                onDone: () => {
                    this.doneFlag = true;
                    this.wakeUp();
                },
                onError: (message: string) => {
                    console.error('[browser-whisper] Fatal pipeline error:', message);
                    this.error = new BrowserWhisperError(message);
                    this.wakeUp();
                },
            },
            { whisperWorker: this.whisperWorker },
        );

        try {
            await this.bridge.start(
                this.file,
                options.model as ASRModel | undefined ?? 'whisper-tiny',
                options.language,
                options.quantization,
            );
        } catch (err) {
            console.error('[browser-whisper] Initialization error:', err);
            this.error = err instanceof Error ? err : new BrowserWhisperError(String(err));
            this.wakeUp();
        }
    }

    /** Resolve the pending Promise inside the async iterator */
    private wakeUp(): void {
        const resolver = this.notify;
        this.notify = null;
        resolver?.();
    }
}

export class TranscribePCMStream implements AsyncIterable<TranscriptSegment> {
    private readonly samples: Float32Array;
    private readonly options: TranscribeOptions;
    private readonly whisperWorker: Worker;

    private readonly queue: TranscriptSegment[] = [];
    private doneFlag = false;
    private error: Error | undefined;
    private notify: (() => void) | null = null;
    private bridge: Bridge | null = null;

    constructor(samples: Float32Array, options: TranscribeOptions, whisperWorker: Worker) {
        this.samples = samples;
        this.options = options;
        this.whisperWorker = whisperWorker;
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<TranscriptSegment> {
        await this.startBridge();

        while (true) {
            if (this.queue.length > 0) {
                yield this.queue.shift()!;
            } else if (this.error) {
                throw this.error;
            } else if (this.doneFlag) {
                return;
            } else {
                await new Promise<void>((resolve) => {
                    this.notify = resolve;
                });
            }
        }
    }

    async collect(): Promise<TranscriptSegment[]> {
        const segments: TranscriptSegment[] = [];
        for await (const segment of this) segments.push(segment);
        return segments;
    }

    cancel(): void {
        this.bridge?.terminate();
        this.doneFlag = true;
        this.wakeUp();
    }

    private async startBridge(): Promise<void> {
        const { options } = this;

        this.bridge = new Bridge(
            {
                onSegment: (segment: TranscriptSegment) => {
                    this.queue.push(segment);
                    options.onSegment?.(segment);
                    this.wakeUp();
                },
                onProgress: (event: TranscribeProgress) => {
                    options.onProgress?.(event);
                },
                onDone: () => {
                    this.doneFlag = true;
                    this.wakeUp();
                },
                onError: (message: string) => {
                    console.error('[browser-whisper] Fatal PCM pipeline error:', message);
                    this.error = new BrowserWhisperError(message);
                    this.wakeUp();
                },
            },
            { whisperWorker: this.whisperWorker },
        );

        try {
            await this.bridge.startPCM(
                this.samples,
                options.model as ASRModel | undefined ?? 'whisper-tiny',
                options.language,
                options.quantization,
            );
        } catch (err) {
            console.error('[browser-whisper] PCM initialization error:', err);
            this.error = err instanceof Error ? err : new BrowserWhisperError(String(err));
            this.wakeUp();
        }
    }

    private wakeUp(): void {
        const resolver = this.notify;
        this.notify = null;
        resolver?.();
    }
}
