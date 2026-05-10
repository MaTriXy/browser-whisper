interface StoredResponseMetadata {
    url: string;
    fileName: string;
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
}

interface OPFSCacheOptions {
    legacyCacheName: string;
    rootName?: string;
}

interface CacheLike {
    match(request: RequestInfo | URL): Promise<Response | undefined>;
    put(request: RequestInfo | URL, response: Response): Promise<void>;
}

const DEFAULT_ROOT_NAME = 'browser-whisper-transformers-cache';

/**
 * OPFS-backed cache implementing the subset of the Web Cache API used by
 * transformers.js. It reads OPFS first, migrates legacy Cache API entries on
 * demand, and lets transformers.js fetch remotely when both caches miss.
 */
export function createOPFSCache(options: OPFSCacheOptions): CacheLike {
    const rootName = options.rootName ?? DEFAULT_ROOT_NAME;

    return {
        async match(request: RequestInfo | URL): Promise<Response | undefined> {
            const normalized = normalizeRequest(request);
            const key = await createCacheKey(normalized.url);
            const opfsResponse = await readFromOPFS(rootName, key);

            if (opfsResponse) return opfsResponse;

            const legacyResponse = await readFromLegacyCache(options.legacyCacheName, normalized);
            if (!legacyResponse) return undefined;

            await writeToOPFS(rootName, key, normalized.url, legacyResponse.clone());
            return legacyResponse;
        },

        async put(request: RequestInfo | URL, response: Response): Promise<void> {
            const normalized = normalizeRequest(request);
            const key = await createCacheKey(normalized.url);
            await writeToOPFS(rootName, key, normalized.url, response.clone());
        },
    };
}

function normalizeRequest(request: RequestInfo | URL): Request {
    if (request instanceof Request) return request;
    return new Request(request);
}

async function readFromLegacyCache(
    cacheName: string,
    request: Request,
): Promise<Response | undefined> {
    if (!('caches' in globalThis)) return undefined;

    const cache = await caches.open(cacheName);
    const response = await cache.match(request);
    return response ?? undefined;
}

async function readFromOPFS(
    rootName: string,
    key: string,
): Promise<Response | undefined> {
    const root = await getCacheRoot(rootName);
    const metadata = await getDirectory(root, 'metadata');

    let fileHandle: FileSystemFileHandle;
    let metadataHandle: FileSystemFileHandle;

    try {
        metadataHandle = await metadata.getFileHandle(`${key}.json`);
    } catch {
        return undefined;
    }

    const metadataFile = await metadataHandle.getFile();
    const responseMetadata = JSON.parse(await metadataFile.text()) as StoredResponseMetadata;
    const files = await getDirectory(root, 'files');

    try {
        fileHandle = await files.getFileHandle(responseMetadata.fileName);
    } catch {
        return undefined;
    }

    const file = await fileHandle.getFile();

    return new Response(file.stream(), {
        status: responseMetadata.status,
        statusText: responseMetadata.statusText,
        headers: responseMetadata.headers,
    });
}

async function writeToOPFS(
    rootName: string,
    key: string,
    url: string,
    response: Response,
): Promise<void> {
    if (!response.ok) return;

    const root = await getCacheRoot(rootName);
    const files = await getDirectory(root, 'files');
    const metadata = await getDirectory(root, 'metadata');
    const fileName = `${key}.${crypto.randomUUID()}.bin`;

    await writeFile(files, fileName, await response.arrayBuffer());

    const responseMetadata: StoredResponseMetadata = {
        url,
        fileName,
        status: response.status,
        statusText: response.statusText,
        headers: getHeaders(response),
    };

    const metadataBytes = new TextEncoder().encode(JSON.stringify(responseMetadata));
    await writeFile(metadata, `${key}.json`, metadataBytes);
}

function getHeaders(response: Response): Array<[string, string]> {
    const headers: Array<[string, string]> = [];
    response.headers.forEach((value, key) => {
        headers.push([key, value]);
    });
    return headers;
}

async function getCacheRoot(rootName: string): Promise<FileSystemDirectoryHandle> {
    if (!navigator.storage?.getDirectory) {
        throw new Error('Origin Private File System is not available in this browser.');
    }

    const root = await navigator.storage.getDirectory();
    return getDirectory(root, rootName);
}

async function getDirectory(
    parent: FileSystemDirectoryHandle,
    name: string,
): Promise<FileSystemDirectoryHandle> {
    return parent.getDirectoryHandle(name, { create: true });
}

async function writeFile(
    directory: FileSystemDirectoryHandle,
    name: string,
    data: BufferSource | Blob,
): Promise<void> {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
}

async function createCacheKey(value: string): Promise<string> {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);

    let output = '';
    for (const byte of bytes) {
        output += byte.toString(16).padStart(2, '0');
    }

    return output;
}
