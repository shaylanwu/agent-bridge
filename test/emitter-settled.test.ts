/**
 * Emitter 的终态幂等（P1-1）与「终态后仍可发的读回包」边界
 *
 * 规则来源：`emit()` 会丢弃已终态 taskId 的后续帧，避免迟到日志污染终态视图。
 * 但**读回包**不是在产生事件，而是在回答请求：
 *  - `task_snapshot`（get_task）、`artifact_content`（get_artifact）在协议里明写「终态后仍可取」；
 *  - 一刀切会让「任务跑完再取产物」这条最常见路径永远收不到回复（2026-11-28 WS e2e 实测）。
 */
import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import type { ClientMessage } from '../src/protocol.js';

function make(): { emitter: Emitter; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage), redactLogs: false });
  return { emitter, sent };
}

function settle(emitter: Emitter, taskId: string): void {
  emitter.emit({ type: 'task_status', taskId, status: 'success' });
}

describe('Emitter 终态幂等', () => {
  it('终态后的 task_log / task_step 一律丢弃', () => {
    const { emitter, sent } = make();
    settle(emitter, 't1');
    emitter.emit({ type: 'task_log', taskId: 't1', stream: 'stdout', data: 'late\n' });
    expect(sent.filter((msg) => msg.type === 'task_log')).toHaveLength(0);
  });

  it('相同终态可幂等重放，不同终态被拒', () => {
    const { emitter, sent } = make();
    settle(emitter, 't2');
    emitter.emit({ type: 'task_status', taskId: 't2', status: 'success' });
    emitter.emit({ type: 'task_status', taskId: 't2', status: 'failed', errorCode: 'agent_error' });
    const statuses = sent.filter((msg) => msg.type === 'task_status');
    expect(statuses).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({ status: 'success' });
  });

  it('artifact_content 在终态后仍必须上行（协议：终态后仍可取）', () => {
    const { emitter, sent } = make();
    settle(emitter, 't3');
    emitter.emit({
      type: 'artifact_content',
      taskId: 't3',
      artifactId: 'art_1',
      requestId: 'req_1',
      found: false,
      errorCode: 'artifact_not_found',
    });
    const reply = sent.find((msg) => msg.type === 'artifact_content');
    expect(reply).toMatchObject({ found: false, errorCode: 'artifact_not_found' });
  });

  it('task_snapshot 在终态后仍必须上行（补取语义）', () => {
    const { emitter, sent } = make();
    settle(emitter, 't4');
    emitter.emit({ type: 'task_snapshot', taskId: 't4', found: false });
    expect(sent.filter((msg) => msg.type === 'task_snapshot')).toHaveLength(1);
  });
});
