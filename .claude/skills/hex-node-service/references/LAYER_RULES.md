# Layer Rules

These rules apply equally to both the **strict** (`adapters/inbound/`, `adapters/outbound/`) and **pragmatic** (`presentation/`, `infrastructure/`) layouts. Only the directory names differ — the isolation contract is identical.

## Domain (core)

- **Zero** infrastructure imports — no ORMs, no HTTP frameworks, no `node:fs`, no `node:net`
- Models are plain TypeScript types or classes (entities, value objects)
- Services implement inbound port interfaces and depend only on outbound port interfaces
- Ports (interfaces) are defined here and owned by the domain — adapters implement them from the outside
- All logic is pure and unit-testable with no infrastructure running

**Enforce with ESLint** (`eslint-plugin-boundaries` or import rules) to catch violations at lint time.

## Inbound adapters (`adapters/inbound/` or `presentation/`)

- HTTP controllers: parse request, call the inbound port, map response — no business logic
- Consumers: deserialise message payload, call the inbound port, ack/nack — no business logic
- Must not import from the outbound layer directly; all calls go through domain service interfaces

## Outbound adapters (`adapters/outbound/` or `infrastructure/`)

- Each adapter implements exactly one outbound port interface
- Contains all SQL, HTTP client, SDK calls — the domain never sees these
- Pair each real adapter with an in-memory fake for use in tests

## Composition root (`app.ts`)

- The only place where concrete adapters are instantiated and injected
- Wires outbound adapters into domain services, then inbound adapters to domain service interfaces
- No business logic; purely construction and wiring

## Common pitfalls

| Pitfall                                          | Fix                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| ORM entity imported in domain service            | Define a domain model type; map in the repository adapter                    |
| HTTP `Request` object passed into domain service | Map to a plain DTO before calling the port                                   |
| Business logic in controller                     | Move to domain service; controller only translates                           |
| Port for every tiny function                     | Ports represent genuine external boundaries — not every helper needs one     |
| Anemic domain model                              | Logic belongs in `<component>.service.ts`, not in a controller or repository |
