import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';

interface EventBusOptions {
  redis: { url: string };
  deadLetterQueue?: {
    enabled: boolean;
    maxRetries?: number;
    retryDelay?: number[];
  };
  consumerGroup?: string;
  consumerId?: string;
}

interface Event<T = unknown> {
  id: string;
  type: string;
  data: T;
  metadata: {
    timestamp: number;
    retryCount: number;
    source?: string;
  };
}

type EventHandler<T> = (data: T, event: Event<T>) => Promise<void>;
type Middleware = (event: Event, next: () => Promise<void>) => Promise<void>;

export class EventBus {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private handlers: Map<string, EventHandler<unknown>[]> = new Map();
  private middlewares: Middleware[] = [];
  private options: EventBusOptions;
  private stats = { published: 0, consumed: 0, failed: 0, deadLettered: 0 };

  constructor(options: EventBusOptions) {
    this.options = options;
    this.publisher = createClient({ url: options.redis.url });
    this.subscriber = createClient({ url: options.redis.url });
  }

  async connect(): Promise<void> {
    await Promise.all([
      this.publisher.connect(),
      this.subscriber.connect(),
    ]);
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.publisher.disconnect(),
      this.subscriber.disconnect(),
    ]);
  }

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  async publish<T>(type: string, data: T): Promise<string> {
    const event: Event<T> = {
      id: uuid(),
      type,
      data,
      metadata: {
        timestamp: Date.now(),
        retryCount: 0,
      },
    };

    // Run through publish middlewares
    await this.runMiddlewares(event as Event);

    await this.publisher.publish(type, JSON.stringify(event));
    this.stats.published++;

    return event.id;
  }

  subscribe<T>(pattern: string, handler: EventHandler<T>): void {
    const handlers = this.handlers.get(pattern) || [];
    handlers.push(handler as EventHandler<unknown>);
    this.handlers.set(pattern, handlers);

    // Subscribe to Redis channel
    this.subscriber.pSubscribe(pattern, async (message, channel) => {
      const event: Event<T> = JSON.parse(message);

      try {
        // Run through middlewares
        await this.runMiddlewares(event as Event);

        // Execute handlers
        const channelHandlers = this.handlers.get(pattern) || [];
        for (const h of channelHandlers) {
          await h(event.data, event as Event<unknown>);
        }

        this.stats.consumed++;
      } catch (error) {
        this.stats.failed++;
        await this.handleFailure(event as Event, error as Error);
      }
    });
  }

  private async runMiddlewares(event: Event): Promise<void> {
    let index = 0;

    const next = async (): Promise<void> => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        await middleware(event, next);
      }
    };

    await next();
  }

  private async handleFailure(event: Event, error: Error): Promise<void> {
    const dlq = this.options.deadLetterQueue;

    if (!dlq?.enabled) {
      throw error;
    }

    const maxRetries = dlq.maxRetries || 3;

    if (event.metadata.retryCount < maxRetries) {
      // Retry with delay
      const delays = dlq.retryDelay || [1000, 5000, 30000];
      const delay = delays[event.metadata.retryCount] || delays[delays.length - 1];

      event.metadata.retryCount++;

      setTimeout(async () => {
        await this.publisher.publish(event.type, JSON.stringify(event));
      }, delay);
    } else {
      // Move to dead letter queue
      await this.publisher.lPush(`dlq:${event.type}`, JSON.stringify({
        ...event,
        error: error.message,
        failedAt: Date.now(),
      }));
      this.stats.deadLettered++;
    }
  }

  async getDeadLetters(type: string): Promise<Event[]> {
    const items = await this.publisher.lRange(`dlq:${type}`, 0, -1);
    return items.map((item) => JSON.parse(item));
  }

  async removeFromDeadLetter(type: string, eventId: string): Promise<void> {
    const items = await this.getDeadLetters(type);
    const filtered = items.filter((e) => e.id !== eventId);
    await this.publisher.del(`dlq:${type}`);
    for (const item of filtered) {
      await this.publisher.rPush(`dlq:${type}`, JSON.stringify(item));
    }
  }

  getStats() {
    return { ...this.stats };
  }

  /**
   * Replay dead letter events back to their original queue
   */
  async replayDeadLetters(type: string, limit?: number): Promise<number> {
    const items = await this.getDeadLetters(type);
    const toReplay = limit ? items.slice(0, limit) : items;

    for (const event of toReplay) {
      event.metadata.retryCount = 0;
      await this.publisher.publish(type, JSON.stringify(event));
    }

    // Remove replayed items from DLQ
    await this.publisher.del(`dlq:${type}`);
    const remaining = limit ? items.slice(limit) : [];
    for (const item of remaining) {
      await this.publisher.rPush(`dlq:${type}`, JSON.stringify(item));
    }

    return toReplay.length;
  }
}

export default EventBus;
export type { Event, EventHandler, EventBusOptions };
