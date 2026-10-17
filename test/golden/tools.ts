import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import { BrowserManager } from '../../src/browser/manager.ts';
import { BrowserSession } from '../../src/browser/session.ts';
import { openDatabase } from '../../src/db/database.ts';
import { Transcript } from '../../src/log/transcript.ts';
import { inputSchema } from '../../src/mcp/schema.ts';
import type { Tool } from '../../src/mcp/tool.ts';
import { AttachmentStore } from '../../src/stores/attachments.ts';
import { InstructionsStore } from '../../src/stores/instructions.ts';
import { MemoryStore } from '../../src/stores/memory.ts';
import { RenderStore } from '../../src/stores/renders.ts';
import { SkillsStore } from '../../src/stores/skills.ts';
import { createBot } from '../../src/telegram/bot.ts';
import { buildTools } from '../../src/tools/index.ts';
import { FakeTelegram } from '../fakes/telegram.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { loadGolden } from './load.ts';

export interface GoldenTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const goldenTools = loadGolden<{ tools: GoldenTool[] }>('mcp-tools.json').tools;

/** A tool's name, description and input schema exactly as the snapshot records them. */
export function expectGoldenTool(tool: Tool): void {
  const golden = goldenTools.find((t) => t.name === tool.name);
  expect(golden, `no golden entry for ${tool.name}`).toBeDefined();
  expect({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool.args) }).toEqual(golden);
}

/** The full tool registry on fakes and temp stores, as the app builds it. */
export function goldenRegistry(disabled: string[] = []) {
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  const dir = tempDir();
  mkdirSync(join(dir, 'attachments'));
  const browser = new BrowserManager({ headless: true, log });
  const ctx = {
    api: bot.api,
    me: () => fake.botInfo,
    db: openDatabase(join(dir, 'h.db'), log),
    dbPath: join(dir, 'h.db'),
    memory: new MemoryStore(join(dir, 'memories')),
    skills: new SkillsStore(join(dir, 'skills')),
    instructions: new InstructionsStore(join(dir, 'project.md'), join(dir, 'prompt_backups')),
    attachments: new AttachmentStore(join(dir, 'attachments')),
    renders: new RenderStore(join(dir, 'renders')),
    browser,
    browserSession: new BrowserSession({ manager: browser, log }),
    chatTitles: new Map<number, string>(),
    transcript: new Transcript(log, 'compact'),
    log,
    onChatReplied: () => {},
  };
  return { tools: buildTools(ctx, new Set(disabled), log), log };
}
