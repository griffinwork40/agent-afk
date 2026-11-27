import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import {
  findHandoffByTelegramMessage,
  listPendingHandoffs,
  readHandoff,
  updateHandoffAnswer,
  updateHandoffMessage,
  writeHandoff,
  type HandoffRecord,
} from './handoff-store.js';

vi.mock('node:timers/promises', { spy: true });
vi.mock('../../utils/atomic-write.js', { spy: true });

const record: HandoffRecord = {
  taskId: 'q-reissued',
  sessionId: 'sess-1',
  question: { message: 'Pick one' },
  requestType: 'ask_question',
  createdAt: '2026-11-27T00:00:00.000Z',
  status: 'pending',
  originalCommand: '/original',
};
const { taskId } = record;
const route = { chatId: 1234, threadId: 5 };
let handoffsDir: string;

beforeEach(async () => {
  handoffsDir = await mkdtemp(join(tmpdir(), 'handoff-identity-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(handoffsDir, { recursive: true, force: true });
});

function barrier(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function writeLegacyRecord(): Promise<void> {
  await writeFile(join(handoffsDir, `${taskId}.json`), JSON.stringify(record));
}

it('bounds replacement retries without touching a busy record', async () => {
  const original = await writeHandoff(record, handoffsDir);
  await writeFile(join(handoffsDir, `${taskId}.lock`), '', { flag: 'wx' });
  vi.mocked(sleep).mockResolvedValue(undefined);

  await expect(writeHandoff(record, handoffsDir)).rejects.toThrow(/timed out waiting to replace handoff/);
  expect(await readHandoff(taskId, handoffsDir)).toEqual(original);
});

describe('question-scoped answers', () => {
  it('keeps replacement out of a held answer lock, then rejects an answer to the previous question', async () => {
    const original = await writeHandoff(record, handoffsDir);
    const answerReachedWrite = barrier();
    const allowAnswerWrite = barrier();
    const replacementReachedRetry = barrier();
    const allowReplacementRetry = barrier();
    const { atomicWriteFileAsync: realWrite } = await vi.importActual<typeof import('../../utils/atomic-write.js')>(
      '../../utils/atomic-write.js',
    );
    vi.mocked(atomicWriteFileAsync).mockImplementationOnce(async (...args) => {
      answerReachedWrite.release();
      await allowAnswerWrite.wait;
      return realWrite(...args);
    });
    vi.mocked(sleep).mockImplementationOnce(async () => {
      replacementReachedRetry.release();
      await allowReplacementRetry.wait;
    });

    const answer = updateHandoffAnswer(taskId, 'first', 'telegram', {
      handoffsDir,
      expectedQuestionId: original.questionId,
    });
    const answerFinished = answer.then(() => { throw new Error('Answer did not pause before its write'); });
    let replacement: ReturnType<typeof writeHandoff> | undefined;
    try {
      await Promise.race([answerReachedWrite.wait, answerFinished]);
      replacement = writeHandoff({ ...record, question: { message: 'Replacement' } }, handoffsDir);
      await Promise.race([
        replacementReachedRetry.wait,
        replacement.then(() => { throw new Error('Replacement finished before the answer released its lock'); }),
      ]);
      expect(await readHandoff(taskId, handoffsDir)).toEqual(original);
      allowAnswerWrite.release();
      expect(await answer).toEqual({ won: true });
      expect(await readHandoff(taskId, handoffsDir)).toMatchObject({
        questionId: original.questionId, status: 'answered', answer: 'first',
      });
    } finally {
      allowAnswerWrite.release();
      allowReplacementRetry.release();
      await Promise.allSettled([answer, replacement]);
    }

    const pending = await replacement;
    expect(pending.questionId).not.toBe(original.questionId);
    expect(await listPendingHandoffs(handoffsDir)).toEqual([pending]);
    await expect(updateHandoffAnswer(taskId, 'stale', 'telegram', {
      handoffsDir,
      expectedQuestionId: original.questionId,
    })).resolves.toEqual({ won: false });
    expect(await readHandoff(taskId, handoffsDir)).toEqual(pending);
  });

  it('returns false for missing and closed scoped records', async () => {
    const original = await writeHandoff({ ...record, status: 'answered' }, handoffsDir);
    const opts = { handoffsDir, expectedQuestionId: original.questionId };
    await expect(updateHandoffAnswer(taskId, 'stale', 'telegram', opts)).resolves.toEqual({ won: false });
    await expect(updateHandoffAnswer('q-missing', 'stale', 'telegram', opts)).resolves.toEqual({ won: false });
  });

  it('treats null as legacy only and explicit undefined as unscoped', async () => {
    await writeLegacyRecord();
    await expect(updateHandoffAnswer(taskId, 'new-only', 'telegram', {
      handoffsDir,
      expectedQuestionId: 'new-question',
    })).resolves.toEqual({ won: false });
    await expect(updateHandoffAnswer(taskId, 'legacy', 'telegram', {
      handoffsDir,
      expectedQuestionId: null,
    })).resolves.toEqual({ won: true });
    expect(await readHandoff(taskId, handoffsDir)).not.toHaveProperty('questionId');

    const current = await writeHandoff(record, handoffsDir);
    await expect(updateHandoffAnswer(taskId, 'legacy', 'telegram', {
      handoffsDir,
      expectedQuestionId: null,
    })).resolves.toEqual({ won: false });
    await expect(updateHandoffAnswer(taskId, 'unscoped', 'web', {
      handoffsDir,
      expectedQuestionId: undefined,
    })).resolves.toEqual({ won: true });
    expect(await readHandoff(taskId, handoffsDir)).toMatchObject({ questionId: current.questionId });
  });
});

describe('Telegram delivery metadata', () => {
  it('bounds retries on a busy lock and never creates a missing handoff', async () => {
    await updateHandoffMessage(taskId, null, route, 10, handoffsDir);
    expect(await readHandoff(taskId, handoffsDir)).toBeNull();

    const original = await writeHandoff(record, handoffsDir);
    await writeFile(join(handoffsDir, `${taskId}.lock`), '', { flag: 'wx' });
    vi.mocked(sleep).mockResolvedValue(undefined);
    await expect(updateHandoffMessage(taskId, original.questionId, route, 10, handoffsDir))
      .rejects.toThrow(/timed out waiting to update handoff message/);
    expect(await readHandoff(taskId, handoffsDir)).toEqual(original);
  });

  it('waits for an answer holding the lock and appends the copy without changing the answer', async () => {
    const { questionId } = await writeHandoff(record, handoffsDir);
    const answerReachedWrite = barrier();
    const allowAnswerWrite = barrier();
    const metadataReachedRetry = barrier();
    const allowMetadataRetry = barrier();
    const { atomicWriteFileAsync: realWrite } = await vi.importActual<typeof import('../../utils/atomic-write.js')>(
      '../../utils/atomic-write.js',
    );
    vi.mocked(atomicWriteFileAsync).mockImplementationOnce(async (...args) => {
      answerReachedWrite.release();
      await allowAnswerWrite.wait;
      return realWrite(...args);
    });
    vi.mocked(sleep).mockImplementationOnce(async () => {
      metadataReachedRetry.release();
      await allowMetadataRetry.wait;
    });

    const answer = updateHandoffAnswer(taskId, 'keep this', 'web', { handoffsDir, expectedQuestionId: questionId });
    let metadata: Promise<void> | undefined;
    try {
      await Promise.race([
        answerReachedWrite.wait,
        answer.then(() => { throw new Error('Answer did not pause before its write'); }),
      ]);
      metadata = updateHandoffMessage(taskId, questionId, route, 11, handoffsDir);
      await Promise.race([
        metadataReachedRetry.wait,
        metadata.then(() => { throw new Error('Metadata did not wait for the answer lock'); }),
      ]);
      allowAnswerWrite.release();
      expect(await answer).toEqual({ won: true });
      const closed = await readHandoff(taskId, handoffsDir);
      allowMetadataRetry.release();
      await metadata;
      const updated = {
        ...closed, route, telegramMessageId: 11, telegramCopies: [{ ...route, messageId: 11, questionId }],
      };
      expect(await readHandoff(taskId, handoffsDir)).toEqual(updated);
      expect(await findHandoffByTelegramMessage(route.chatId, 11, handoffsDir))
        .toEqual({ record: updated, questionId, threadId: route.threadId });
    } finally {
      allowAnswerWrite.release();
      allowMetadataRetry.release();
      await Promise.allSettled([answer, metadata]);
    }
  });

  it('keeps legacy route fields for raw sends and retains copy identities across replacement', async () => {
    const legacy = { ...record, route, telegramMessageId: 41 };
    await writeFile(join(handoffsDir, `${taskId}.json`), JSON.stringify(legacy));
    expect(await findHandoffByTelegramMessage(route.chatId, 41, handoffsDir))
      .toEqual({ record: legacy, questionId: null, threadId: route.threadId });

    const rawRoute = { chatId: 4321 };
    await updateHandoffMessage(taskId, null, rawRoute, 41, handoffsDir, { preserveRoute: true });
    await updateHandoffMessage(taskId, null, rawRoute, 41, handoffsDir, { preserveRoute: true });
    expect(await readHandoff(taskId, handoffsDir)).toEqual({
      ...legacy, telegramCopies: [
        { ...route, messageId: 41, questionId: null },
        { ...rawRoute, messageId: 41, questionId: null },
      ],
    });
    const previous = await writeHandoff(legacy, handoffsDir);
    expect(previous).not.toHaveProperty('telegramMessageId');
    await updateHandoffMessage(taskId, previous.questionId, route, 42, handoffsDir);
    // Use a stale draft without message 42; replacement must read history from disk.
    const current = await writeHandoff(previous, handoffsDir);
    await updateHandoffMessage(taskId, previous.questionId, route, 43, handoffsDir);
    await updateHandoffMessage(taskId, null, route, 43, handoffsDir);
    await updateHandoffMessage(taskId, current.questionId, route, 42, handoffsDir);
    expect(await readHandoff(taskId, handoffsDir)).toEqual(current);
    expect(await findHandoffByTelegramMessage(route.chatId, 42, handoffsDir))
      .toEqual({ record: current, questionId: previous.questionId, threadId: route.threadId });
    expect(await findHandoffByTelegramMessage(rawRoute.chatId, 41, handoffsDir))
      .toEqual({ record: current, questionId: null });
    await expect(findHandoffByTelegramMessage(route.chatId, 43, handoffsDir)).resolves.toBeUndefined();
    await expect(findHandoffByTelegramMessage(rawRoute.chatId, 42, handoffsDir)).resolves.toBeUndefined();
  });

  it('treats a chat/message pair claimed by two records as ambiguous', async () => {
    await writeHandoff({ ...record, route, telegramMessageId: 41 }, handoffsDir);
    await writeHandoff({ ...record, taskId: 'q-other', route, telegramMessageId: 41 }, handoffsDir);
    await expect(findHandoffByTelegramMessage(route.chatId, 41, handoffsDir)).resolves.toBeUndefined();
  });
});
