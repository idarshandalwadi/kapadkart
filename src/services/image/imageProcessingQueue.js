import { IMAGE_CONFIG } from '../../config/imageConfig.js';

class ImageProcessingQueue {
  constructor(concurrency = IMAGE_CONFIG.concurrency, capacity = IMAGE_CONFIG.queueCapacity) {
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.activeCount = 0;
    this.queue = [];
  }

  /**
   * Enqueue an async image processing task.
   * Throws HTTP 429 style error if queue exceeds capacity.
   */
  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.capacity) {
        const error = new Error('Image processing service is currently overloaded. Please try again shortly.');
        error.statusCode = 429;
        return reject(error);
      }

      this.queue.push({ taskFn, resolve, reject, enqueuedAt: Date.now() });
      this.dequeue();
    });
  }

  async dequeue() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.activeCount++;
    const { taskFn, resolve, reject } = this.queue.shift();

    try {
      const result = await taskFn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.activeCount--;
      this.dequeue();
    }
  }

  getStats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      capacity: this.capacity,
      concurrency: this.concurrency
    };
  }
}

export const imageProcessingQueue = new ImageProcessingQueue();
