import { describe, it, expect, beforeEach } from 'vitest';
import { getTaskState, startTask, updateTaskProgress, finishTask, failTask, setTaskBroadcaster } from './task-state.js';

describe('task-state', () => {
  beforeEach(() => {
    finishTask(null, 'Reset');
  });

  it('starts with an idle state', () => {
    const state = getTaskState();
    expect(state.isRunning).toBe(false);
    expect(state.type).toBe('IDLE');
  });

  it('updates state when startTask, updateTaskProgress, and finishTask are called', () => {
    const events: any[] = [];
    setTaskBroadcaster((evt) => events.push(evt));

    startTask('REPAIR', 50, 'Starting repair...');
    let state = getTaskState();
    expect(state.isRunning).toBe(true);
    expect(state.type).toBe('REPAIR');
    expect(state.totalFiles).toBe(50);
    expect(state.percent).toBe(0);

    updateTaskProgress(25, 'invoice_123.pdf', 'REPAIRING', 'Repairing file 25/50');
    state = getTaskState();
    expect(state.processedFiles).toBe(25);
    expect(state.percent).toBe(50);
    expect(state.currentFile).toBe('invoice_123.pdf');

    finishTask({ repairedCount: 25 }, 'Repair finished');
    state = getTaskState();
    expect(state.isRunning).toBe(false);
    expect(state.percent).toBe(100);
    expect(state.stage).toBe('COMPLETED');
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('handles failTask properly', () => {
    startTask('SCAN', 10, 'Scanning...');
    failTask('Disk error');
    const state = getTaskState();
    expect(state.isRunning).toBe(false);
    expect(state.stage).toBe('FAILED');
    expect(state.error).toBe('Disk error');
  });
});
