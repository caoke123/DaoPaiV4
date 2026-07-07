/**
 * WindowLaunchSemaphore — Chrome 冷启动并发限流 (M5-2A)
 *
 * 限制 open_window / restart_window 的 Chrome 进程启动并发数，
 * 避免多窗口同时启动导致性能严重抖动（实测 3 并发时某窗口 75.7s）。
 *
 * close_window / refresh_status 不受影响。
 *
 * 配置：AGENT_WINDOW_OPEN_CONCURRENCY=1（默认）
 */

const CONCURRENCY = parseInt(process.env.AGENT_WINDOW_OPEN_CONCURRENCY || '1', 10) || 1;

interface QueuedTask {
  windowId: string;
  resolve: () => void;
}

let activeCount = 0;
const queue: QueuedTask[] = [];

console.log(`[WindowLaunchSemaphore] windowOpenConcurrency=${CONCURRENCY}`);

/**
 * Acquire a launch slot. If no slots available, wait in queue.
 * Returns a release function. Caller MUST call release() when Chrome process start is done.
 */
export function acquireLaunchSlot(windowId: string): Promise<() => void> {
  if (CONCURRENCY <= 0) {
    // No limit
    return Promise.resolve(() => {});
  }

  if (activeCount < CONCURRENCY) {
    activeCount++;
    console.log(`[WindowLaunchSemaphore] open_window acquired launch slot windowId=${windowId} (active=${activeCount}/${CONCURRENCY})`);
    return Promise.resolve(() => {
      activeCount--;
      console.log(`[WindowLaunchSemaphore] open_window released launch slot windowId=${windowId} (active=${activeCount}/${CONCURRENCY})`);
      processNext();
    });
  }

  // Queue this request
  console.log(`[WindowLaunchSemaphore] open_window waiting for launch slot windowId=${windowId} (active=${activeCount}/${CONCURRENCY}, queue=${queue.length + 1})`);
  return new Promise((resolve) => {
    queue.push({
      windowId,
      resolve: () => {
        activeCount++;
        console.log(`[WindowLaunchSemaphore] open_window acquired launch slot windowId=${windowId} (active=${activeCount}/${CONCURRENCY})`);
        resolve(() => {
          activeCount--;
          console.log(`[WindowLaunchSemaphore] open_window released launch slot windowId=${windowId} (active=${activeCount}/${CONCURRENCY})`);
          processNext();
        });
      },
    });
  });
}

function processNext(): void {
  const next = queue.shift();
  if (next) {
    next.resolve();
  }
}
