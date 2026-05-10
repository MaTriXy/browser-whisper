import { BrowserWhisper, type ASRModel, type TranscribeProgress } from '../../../src/index.js';

const modelSelect = document.querySelector<HTMLSelectElement>('#model');
const downloadButton = document.querySelector<HTMLButtonElement>('#download');
const transcribeButton = document.querySelector<HTMLButtonElement>('#transcribe');
const repeatButton = document.querySelector<HTMLButtonElement>('#repeat');
const logElement = document.querySelector<HTMLPreElement>('#log');
const segmentsElement = document.querySelector<HTMLDivElement>('#segments');

if (!modelSelect || !downloadButton || !transcribeButton || !repeatButton || !logElement || !segmentsElement) {
    throw new Error('MP3 transcribe UI failed to initialize.');
}

function selectedModel(): ASRModel {
    return modelSelect.value as ASRModel;
}

function appendLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    logElement.textContent += `[${timestamp}] ${message}\n`;
    logElement.scrollTop = logElement.scrollHeight;
}

function renderProgress(prefix: string, event: TranscribeProgress): void {
    appendLog(`${prefix}: ${event.stage} ${Math.round(event.progress * 100)}%`);
}

function setBusy(isBusy: boolean): void {
    downloadButton.disabled = isBusy;
    transcribeButton.disabled = isBusy;
    repeatButton.disabled = isBusy;
    modelSelect.disabled = isBusy;
}

async function createAudioFile(): Promise<File> {
    const response = await fetch('/audio.mp3');
    if (!response.ok) {
        throw new Error(`Failed to fetch /audio.mp3: ${response.status}`);
    }

    const blob = await response.blob();
    return new File([blob], 'audio.mp3', { type: blob.type || 'audio/mpeg' });
}

async function downloadModel(label: string): Promise<void> {
    setBusy(true);
    const startedAt = performance.now();
    const whisper = new BrowserWhisper();

    try {
        appendLog(`${label}: starting ${selectedModel()}`);
        await whisper.downloadModel({
            model: selectedModel(),
            quantization: 'hybrid',
            onProgress: (event) => renderProgress(label, event),
        });
        appendLog(`${label}: completed in ${Math.round(performance.now() - startedAt)}ms`);
    } catch (error) {
        appendLog(`${label}: failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        setBusy(false);
    }
}

downloadButton.addEventListener('click', () => {
    void downloadModel('download');
});

repeatButton.addEventListener('click', () => {
    void downloadModel('repeat');
});

transcribeButton.addEventListener('click', async () => {
    setBusy(true);
    segmentsElement.textContent = '';
    const whisper = new BrowserWhisper({ model: selectedModel(), quantization: 'hybrid' });

    try {
        appendLog(`transcribe: fetching audio.mp3`);
        const file = await createAudioFile();
        appendLog(`transcribe: starting ${file.name} (${file.size} bytes)`);

        for await (const segment of whisper.transcribe(file, {
            onProgress: (event) => renderProgress('transcribe', event),
        })) {
            const row = document.createElement('div');
            const timestamp = document.createElement('span');
            row.className = 'segment';
            timestamp.className = 'time';
            timestamp.textContent = `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}s`;
            row.append(timestamp, ` ${segment.text}`);
            segmentsElement.append(row);
        }

        appendLog('transcribe: done');
    } catch (error) {
        appendLog(`transcribe: failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        setBusy(false);
    }
});

appendLog('ready');
