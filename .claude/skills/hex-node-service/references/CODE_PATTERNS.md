# Code Patterns

## Domain model

```typescript
// domain/users/user.model.ts
export type User = {
  id: string;
  email: string;
  createdAt: Date;
};
```

## Outbound port (interface owned by domain)

```typescript
// domain/ports/outbound/IUserRepository.ts
import type { User } from '@/domain/users/user.model.js';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
}
```

## Inbound port

```typescript
// domain/ports/inbound/IUserService.ts
import type { User } from '@/domain/users/user.model.js';

export interface IUserService {
  getUser(id: string): Promise<User>;
  createUser(email: string): Promise<User>;
}
```

## Domain service (pure — implements inbound port, depends on outbound port)

```typescript
// domain/users/user.service.ts
import type { IUserRepository } from '@/domain/ports/outbound/IUserRepository.js';
import type { IUserService } from '@/domain/ports/inbound/IUserService.js';
import type { User } from './user.model.js';

export class UserService implements IUserService {
  constructor(private readonly repo: IUserRepository) {}

  async getUser(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) throw new Error(`User ${id} not found`);
    return user;
  }

  async createUser(email: string): Promise<User> {
    const user: User = {
      id: crypto.randomUUID(),
      email,
      createdAt: new Date(),
    };
    await this.repo.save(user);
    return user;
  }
}
```

## HTTP controller (inbound adapter — no business logic)

```typescript
// adapters/inbound/http/users/user.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IUserService } from '@/domain/ports/inbound/IUserService.js';

export class UserController {
  constructor(private readonly userService: IUserService) {}

  async getUser(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = await this.userService.getUser(req.params.id);
    await reply.send(user);
  }
}
```

## Repository (outbound adapter — implements domain port)

```typescript
// adapters/outbound/persistence/postgres/user.repository.ts
import type { IUserRepository } from '@/domain/ports/outbound/IUserRepository.js';
import type { User } from '@/domain/users/user.model.js';

export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return row ? mapRowToUser(row) : null;
  }

  async save(user: User): Promise<void> {
    await this.db.query(
      'INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET email = $2',
      [user.id, user.email, user.createdAt]
    );
  }
}

function mapRowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    createdAt: new Date(row.created_at as string),
  };
}
```

## In-memory fake (for tests)

```typescript
// adapters/outbound/persistence/in-memory/user.repository.fake.ts
import type { IUserRepository } from '@/domain/ports/outbound/IUserRepository.js';
import type { User } from '@/domain/users/user.model.js';

export class InMemoryUserRepository implements IUserRepository {
  #store = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    return this.#store.get(id) ?? null;
  }

  async save(user: User): Promise<void> {
    this.#store.set(user.id, user);
  }
}
```

## Composition root

```typescript
// app.ts
import { PostgresUserRepository } from '@/adapters/outbound/persistence/postgres/user.repository.js';
import { UserService } from '@/domain/users/user.service.js';
import { UserController } from '@/adapters/inbound/http/users/user.controller.js';
import { buildServer } from '@/adapters/inbound/http/server.js';

export function buildApp(db: DatabaseClient): FastifyInstance {
  // outbound adapters
  const userRepo = new PostgresUserRepository(db);

  // domain services
  const userService = new UserService(userRepo);

  // inbound adapters
  const userController = new UserController(userService);

  return buildServer({ userController });
}
```
