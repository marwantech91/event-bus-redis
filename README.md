# Event Bus Redis

![Redis](https://img.shields.io/badge/Redis-7.0-DC382D?style=flat-square&logo=redis)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

Lightweight event bus for microservices using Redis pub/sub. Features dead letter queue, retry logic, and event schemas.

## Architecture

```
┌──────────────┐     publish      ┌───────────────┐     subscribe     ┌──────────────┐
│  Service A   │ ────────────────►│  Redis Pub/Sub │◄─────────────────│  Service B   │
└──────────────┘                  └───────────────┘                   └──────────────┘
                                         │
                                         │ failed
                                         ▼
                                  ┌───────────────┐
                                  │  Dead Letter  │
                                  │    Queue      │
                                  └───────────────┘
```

## Features

- **Pub/Sub** - Publish events to multiple subscribers
- **Dead Letter Queue** - Capture failed events for retry
- **Retry Logic** - Automatic retries with backoff
- **Event Schemas** - Type-safe event definitions
- **Middleware** - Transform/validate events
- **Metrics** - Built-in event tracking

## Installation

```bash
npm install @marwantech/event-bus-redis
```

## Quick Start

```typescript
import { EventBus } from '@marwantech/event-bus-redis';

const bus = new EventBus({ redis: { url: process.env.REDIS_URL } });

// Define events
interface UserCreatedEvent {
  userId: string;
  email: string;
  timestamp: number;
}

// Subscribe to events
bus.subscribe<UserCreatedEvent>('user.created', async (event) => {
  console.log('New user:', event.userId);
  await sendWelcomeEmail(event.email);
});

// Publish events
await bus.publish('user.created', {
  userId: '123',
  email: 'user@example.com',
  timestamp: Date.now(),
});
```

## Event Patterns

```typescript
// Exact match
bus.subscribe('user.created', handler);

// Wildcard patterns
bus.subscribe('user.*', handler);       // user.created, user.updated, user.deleted
bus.subscribe('*.created', handler);     // user.created, order.created
bus.subscribe('order.*.completed', handler);
```

## Dead Letter Queue

```typescript
const bus = new EventBus({
  redis: { url: process.env.REDIS_URL },
  deadLetterQueue: {
    enabled: true,
    maxRetries: 3,
    retryDelay: [1000, 5000, 30000], // Exponential backoff
  },
});

// Process dead letters manually
const deadLetters = await bus.getDeadLetters('user.created');
for (const event of deadLetters) {
  try {
    await processEvent(event);
    await bus.removeFromDeadLetter(event.id);
  } catch (error) {
    // Leave in DLQ for investigation
  }
}
```

## Middleware

```typescript
// Add timestamp to all events
bus.use(async (event, next) => {
  event.metadata.timestamp = Date.now();
  await next();
});

// Validate events
bus.use(async (event, next) => {
  if (!event.data.userId) {
    throw new Error('userId required');
  }
  await next();
});

// Log all events
bus.use(async (event, next) => {
  console.log(`Event: ${event.type}`, event.data);
  const start = Date.now();
  await next();
  console.log(`Processed in ${Date.now() - start}ms`);
});
```

## Consumer Groups

```typescript
// Multiple instances of same service share the load
const bus = new EventBus({
  redis: { url: process.env.REDIS_URL },
  consumerGroup: 'email-service',
  consumerId: process.env.POD_ID,
});
```

## Metrics

```typescript
const stats = bus.getStats();
// {
//   published: 1000,
//   consumed: 980,
//   failed: 20,
//   deadLettered: 5,
//   avgProcessingTime: 45
// }
```

## License

MIT
