// Conversation storage implementations. Pure core with injected I/O;
// VS Code uses file-backed storage, tests use in-memory.
import { Conversation, ConversationMeta, ConversationStore, newConversationId } from "./chat.js";

export interface StoreIo {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
}

/** File-backed store for VS Code extension (globalStorage). */
export class FileConversationStore implements ConversationStore {
  private readonly dir: string;

  constructor(io: StoreIo, storageDir: string) {
    this.dir = storageDir;
    this.io = io;
  }

  private io: StoreIo;

  async list(): Promise<ConversationMeta[]> {
    try {
      const files = await this.io.listFiles(this.dir);
      const metas: ConversationMeta[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await this.io.readFile(join(this.dir, file));
        if (!content) continue;
        try {
          const conv = JSON.parse(content) as Conversation;
          metas.push({
            id: conv.id,
            title: conv.title,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messageCount: conv.messages.length,
            provider: conv.provider,
            model: conv.model,
          });
        } catch {
          // Skip corrupted files
        }
      }
      // Sort by updatedAt desc
      metas.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
      return metas;
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Conversation | null> {
    try {
      const content = await this.io.readFile(join(this.dir, `${id}.json`));
      if (!content) return null;
      return JSON.parse(content) as Conversation;
    } catch {
      return null;
    }
  }

  async create(conv: Conversation): Promise<void> {
    await this.io.mkdir(this.dir);
    await this.io.writeFile(join(this.dir, `${conv.id}.json`), JSON.stringify(conv, null, 2));
  }

  async update(conv: Conversation): Promise<void> {
    const updated = { ...conv, updatedAt: new Date().toISOString() };
    await this.io.writeFile(join(this.dir, `${conv.id}.json`), JSON.stringify(updated, null, 2));
  }

  async delete(id: string): Promise<void> {
    await this.io.deleteFile(join(this.dir, `${id}.json`));
  }
}

/** In-memory store for tests. */
export class MemoryConversationStore implements ConversationStore {
  private readonly map = new Map<string, Conversation>();

  async list(): Promise<ConversationMeta[]> {
    const metas: ConversationMeta[] = [];
    for (const conv of this.map.values()) {
      metas.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
        provider: conv.provider,
        model: conv.model,
      });
    }
    metas.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    return metas;
  }

  async get(id: string): Promise<Conversation | null> {
    return this.map.get(id) ?? null;
  }

  async create(conv: Conversation): Promise<void> {
    this.map.set(conv.id, conv);
  }

  async update(conv: Conversation): Promise<void> {
    this.map.set(conv.id, { ...conv, updatedAt: new Date().toISOString() });
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

/** Path join helper (platform-agnostic for tests). */
function join(base: string, ...parts: string[]): string {
  return [base, ...parts].join("/").replace(/\/+/g, "/");
}