import { afterEach, describe, expect, it } from 'bun:test';
import { createOPFSCache } from '../lib/opfs-cache.js';

class FakeFile {
    constructor(private readonly bytes: Uint8Array) { }

    stream(): ReadableStream<Uint8Array> {
        return new Blob([this.bytes]).stream();
    }

    async text(): Promise<string> {
        return new TextDecoder().decode(this.bytes);
    }
}

class FakeFileHandle {
    constructor(
        private readonly name: string,
        private readonly files: Map<string, Uint8Array>,
    ) { }

    async getFile(): Promise<FakeFile> {
        const bytes = this.files.get(this.name);
        if (!bytes) throw new Error(`Missing file: ${this.name}`);
        return new FakeFile(bytes);
    }

    async createWritable(): Promise<FakeWritable> {
        return new FakeWritable(this.name, this.files);
    }
}

class FakeWritable {
    private bytes = new Uint8Array();

    constructor(
        private readonly name: string,
        private readonly files: Map<string, Uint8Array>,
    ) { }

    async write(data: BufferSource | Blob): Promise<void> {
        if (data instanceof Blob) {
            this.bytes = new Uint8Array(await data.arrayBuffer());
            return;
        }

        const view = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);

        this.bytes = new Uint8Array(view);
    }

    async close(): Promise<void> {
        this.files.set(this.name, this.bytes);
    }
}

class FakeDirectoryHandle {
    private readonly directories = new Map<string, FakeDirectoryHandle>();
    private readonly files = new Map<string, Uint8Array>();

    async getDirectoryHandle(
        name: string,
        options: { create?: boolean } = {},
    ): Promise<FakeDirectoryHandle> {
        const existing = this.directories.get(name);
        if (existing) return existing;
        if (!options.create) throw new Error(`Missing directory: ${name}`);

        const directory = new FakeDirectoryHandle();
        this.directories.set(name, directory);
        return directory;
    }

    async getFileHandle(
        name: string,
        options: { create?: boolean } = {},
    ): Promise<FakeFileHandle> {
        if (!this.files.has(name) && !options.create) {
            throw new Error(`Missing file: ${name}`);
        }

        if (!this.files.has(name)) {
            this.files.set(name, new Uint8Array());
        }

        return new FakeFileHandle(name, this.files);
    }
}

class FakeBrowserCache {
    readonly entries = new Map<string, Response>();

    async match(request: Request): Promise<Response | undefined> {
        return this.entries.get(request.url)?.clone();
    }
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');

afterEach(() => {
    restoreGlobal('navigator', originalNavigator);
    restoreGlobal('caches', originalCaches);
});

describe('createOPFSCache', () => {
    it('stores and reads responses from OPFS', async () => {
        installFakeOPFS();
        const cache = createOPFSCache({ legacyCacheName: 'transformers-cache' });
        const request = new Request('https://huggingface.co/model/config.json');

        await cache.put(request, new Response('opfs-data', {
            headers: { 'content-type': 'application/json' },
        }));

        const response = await cache.match(request);

        expect(response).toBeDefined();
        expect(await response!.text()).toBe('opfs-data');
        expect(response!.headers.get('content-type')).toBe('application/json');
    });

    it('copies legacy Cache API hits into OPFS on first read', async () => {
        installFakeOPFS();
        const legacyCache = installFakeLegacyCache();
        const cache = createOPFSCache({ legacyCacheName: 'transformers-cache' });
        const request = new Request('https://huggingface.co/model/tokenizer.json');
        legacyCache.entries.set(request.url, new Response('legacy-data'));

        const firstResponse = await cache.match(request);
        legacyCache.entries.clear();
        const secondResponse = await cache.match(request);

        expect(await firstResponse!.text()).toBe('legacy-data');
        expect(await secondResponse!.text()).toBe('legacy-data');
    });

    it('returns undefined when OPFS and legacy cache both miss', async () => {
        installFakeOPFS();
        installFakeLegacyCache();
        const cache = createOPFSCache({ legacyCacheName: 'transformers-cache' });

        const response = await cache.match(new Request('https://huggingface.co/model/missing.json'));

        expect(response).toBeUndefined();
    });
});

function installFakeOPFS(): void {
    const root = new FakeDirectoryHandle();

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            storage: {
                async getDirectory() {
                    return root;
                },
            },
        },
    });
}

function installFakeLegacyCache(): FakeBrowserCache {
    const cache = new FakeBrowserCache();

    Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: {
            async open() {
                return cache;
            },
        },
    });

    return cache;
}

function restoreGlobal(
    name: string,
    descriptor: PropertyDescriptor | undefined,
): void {
    if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
        return;
    }

    delete (globalThis as Record<string, unknown>)[name];
}
