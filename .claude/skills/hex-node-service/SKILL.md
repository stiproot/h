---
name: hex-node-service
description: >
  Build a new Node.js microservice or refactor an existing one to follow Hexagonal Architecture
  (Ports & Adapters): scaffold the domain core, define inbound and outbound ports, implement
  HTTP/consumer inbound adapters and repository/API outbound adapters, and wire them in a
  composition root. Supports a strict ports-and-adapters layout or a pragmatic
  presentation/infrastructure layout for teams that prefer less nesting. Activate when creating
  a Node microservice from scratch, restructuring a layered or monolithic service, isolating
  business logic from infrastructure, or adding a new domain component. Use the pragmatic variant
  when the request signals 'simpler', 'minimal', 'less nesting', or 'pragmatic'.
---

# Hexagonal Architecture Node Microservice

The domain core is the invariant. Infrastructure (HTTP, database, queues) is a detail that surrounds it. Follow these steps in order — the TypeScript interface definitions in Step 2 drive everything else.

---

## Pre-flight

Answer before writing code:

| Question                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New service or refactor of an existing one?                                                                                                                                                |
| What are the domain components? (e.g. `users`, `orders`, `notifications`)                                                                                                                  |
| What inbound adapters are needed? (HTTP, message consumer, CLI)                                                                                                                            |
| What outbound adapters are needed? (Postgres, Redis, external API, email)                                                                                                                  |
| What test framework is in use? (Jest, Vitest, Bun test)                                                                                                                                    |
| Standalone service or part of a monorepo?                                                                                                                                                  |
| **Strict or pragmatic layout?** Strict = `adapters/inbound/` + `adapters/outbound/`. Pragmatic = `presentation/` + `infrastructure/` (flatter, less nesting, same domain isolation rules). |

---

## Step 1 — Scaffold the folder structure

Choose the layout based on the pre-flight answer:

**Strict** (full ports-and-adapters naming):

```
src/
  domain/<component>/
  domain/ports/inbound/
  domain/ports/outbound/
  adapters/inbound/http/<component>/
  adapters/outbound/persistence/postgres/
  adapters/outbound/persistence/in-memory/
```

**Pragmatic** (flatter — use when team signals "simpler", "minimal", or "pragmatic"):

```
src/
  domain/<component>/
  domain/ports/
  presentation/http/<component>/
  presentation/consumers/
  infrastructure/persistence/
  infrastructure/persistence/in-memory/
```

The domain isolation rule is identical for both — only the directory names differ. Steps 5–6 reference `adapters/inbound/` and `adapters/outbound/`; substitute `presentation/` and `infrastructure/` respectively when using the pragmatic layout.

For a **refactor**: identify which existing files contain business logic mixed with infrastructure, and map them to their target layer before moving anything.

See [FOLDER_STRUCTURE.md](references/FOLDER_STRUCTURE.md) for annotated layouts of both variants.

---

## Step 2 — Define domain models

Create one `<component>.model.ts` per domain concept — plain TypeScript types, no framework or ORM imports.

```typescript
// domain/users/user.model.ts
export type User = { id: string; email: string; createdAt: Date };
```

---

## Step 3 — Define ports

Ports are interfaces owned by the domain. Inbound ports define what the service exposes; outbound ports define what it needs from infrastructure.

```typescript
// domain/ports/inbound/IUserService.ts
export interface IUserService {
  getUser(id: string): Promise<User>;
  createUser(email: string): Promise<User>;
}

// domain/ports/outbound/IUserRepository.ts
export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
}
```

---

## Step 4 — Implement domain services

Each service lives in `domain/<component>/<component>.service.ts`, implements its inbound port, and depends only on outbound port interfaces — never on concrete adapters.

```typescript
export class UserService implements IUserService {
  constructor(private readonly repo: IUserRepository) {}
  // business logic only — no SQL, no HTTP, no framework
}
```

See [CODE_PATTERNS.md](references/CODE_PATTERNS.md) for complete service, controller, repository, in-memory fake, and composition root examples.

---

## Step 5 — Implement inbound adapters

**HTTP controllers** (`adapters/inbound/http/<component>/`): parse request → call inbound port → map response. No business logic.

```typescript
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

**Message consumers** (`adapters/inbound/consumers/`): deserialise payload → call inbound port → ack/nack. No business logic.

---

## Step 6 — Implement outbound adapters

Each adapter implements one outbound port interface and contains all SQL, SDK, or HTTP client calls. Alongside each real adapter, create an **in-memory fake** in `adapters/outbound/*/in-memory/` for use in tests.

```typescript
// Real adapter
export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseClient) {}
  async findById(id: string): Promise<User | null> {
    /* SQL here */
  }
  async save(user: User): Promise<void> {
    /* SQL here */
  }
}

// In-memory fake (same interface — used in tests)
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

---

## Step 7 — Wire the composition root (`app.ts`)

`app.ts` is the only place where concrete adapters are instantiated and injected. Wiring order:

1. Instantiate outbound adapters (repositories, API clients)
2. Instantiate domain services, injecting outbound adapters
3. Instantiate inbound adapters (controllers, consumers), injecting domain services
4. Register routes / consumers

---

## Step 8 — Write tests

| Test type                    | Location                                                           | What to use                                 |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| Domain unit tests            | `domain/<component>/<component>.service.test.ts`                   | In-memory fakes only — no database, no HTTP |
| Controller integration tests | `adapters/inbound/http/<component>/<component>.controller.test.ts` | Real controller wired to in-memory fakes    |
| End-to-end integration tests | `tests/integration/<component>.test.ts`                            | Full stack with real DB (or test container) |

---

## Verification Checklist

- [ ] `domain/` has zero imports from `adapters/`, ORMs, HTTP frameworks, or Node built-ins like `node:fs`/`node:net`
- [ ] Every outbound dependency of the domain is behind a port interface
- [ ] Each `*.repository.ts` has a matching `*.repository.fake.ts`
- [ ] `app.ts` is the sole composition root — no `new` calls for adapters elsewhere
- [ ] Domain service unit tests pass with no infrastructure running
- [ ] Controller tests pass using in-memory fakes (no real DB)
- [ ] TypeScript strict mode (`strict: true`) — zero errors

See [LAYER_RULES.md](references/LAYER_RULES.md) for per-layer import rules and common pitfalls.
