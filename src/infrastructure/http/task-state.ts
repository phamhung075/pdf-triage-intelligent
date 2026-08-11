export interface ActiveTaskState {
  isRunning: boolean;
  type: 'IDLE' | 'SCAN' | 'REPAIR' | 'CLEAR';
  totalFiles: number;
  processedFiles: number;
  percent: number;
  currentFile: string;
  stage: string;
  message: string;
  startedAt: string | null;
  result?: any;
  error?: string | null;
}

let activeState: ActiveTaskState = {
  isRunning: false,
  type: 'IDLE',
  totalFiles: 0,
  processedFiles: 0,
  percent: 0,
  currentFile: '',
  stage: '',
  message: 'System idle',
  startedAt: null,
  result: null,
  error: null
};

let eventBroadcaster: ((event: any) => void) | null = null;

export function setTaskBroadcaster(broadcaster: (event: any) => void): void {
  eventBroadcaster = broadcaster;
}

export function getTaskState(): ActiveTaskState {
  return { ...activeState };
}

export function startTask(type: 'SCAN' | 'REPAIR' | 'CLEAR', totalFiles: number, message: string): void {
  activeState = {
    isRunning: true,
    type,
    totalFiles: Math.max(0, totalFiles),
    processedFiles: 0,
    percent: 0,
    currentFile: '',
    stage: 'STARTING',
    message,
    startedAt: new Date().toISOString(),
    result: null,
    error: null
  };
  eventBroadcaster?.({ type: 'TASK_STARTED', taskState: activeState });
}

export function updateTaskProgress(processedFiles: number, currentFile?: string, stage?: string, message?: string, totalFiles?: number): void {
  if (totalFiles !== undefined && totalFiles > 0) {
    activeState.totalFiles = totalFiles;
  }
  if (processedFiles > activeState.processedFiles) {
    activeState.processedFiles = processedFiles;
  }
  if (activeState.totalFiles > 0) {
    activeState.percent = Math.min(100, Math.round((activeState.processedFiles / activeState.totalFiles) * 100));
  } else {
    activeState.percent = 0;
  }
  if (currentFile !== undefined) activeState.currentFile = currentFile;
  if (stage !== undefined) activeState.stage = stage;
  if (message !== undefined) activeState.message = message;

  eventBroadcaster?.({ type: 'TASK_PROGRESS', taskState: activeState });
}

export function finishTask(result?: any, message: string = 'Operation completed successfully'): void {
  activeState.isRunning = false;
  activeState.percent = 100;
  activeState.stage = 'COMPLETED';
  activeState.message = message;
  activeState.result = result;

  eventBroadcaster?.({ type: 'TASK_FINISHED', taskState: activeState });
}

export function failTask(error: string): void {
  activeState.isRunning = false;
  activeState.stage = 'FAILED';
  activeState.error = error;
  activeState.message = `Operation failed: ${error}`;

  eventBroadcaster?.({ type: 'TASK_FAILED', taskState: activeState });
}

export function resetTaskState(): void {
  activeState = {
    isRunning: false,
    type: 'IDLE',
    totalFiles: 0,
    processedFiles: 0,
    percent: 0,
    currentFile: '',
    stage: 'IDLE',
    message: 'System unlocked',
    startedAt: null,
    result: null,
    error: null
  };
  eventBroadcaster?.({ type: 'TASK_FINISHED', taskState: activeState });
}
