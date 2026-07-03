# Folder Structure Templates

## Strict layout (full ports-and-adapters naming)

```
my-svc/
│
├── package.json
├── tsconfig.json
│
├── src/
│   ├── domain/                         # THE CORE — no infrastructure imports allowed
│   │   ├── <component>/                # one folder per domain concept
│   │   │   ├── <component>.model.ts    # entity / value object
│   │   │   ├── <component>.service.ts  # pure business logic
│   │   │   └── <component>.service.test.ts
│   │   └── ports/
│   │       ├── inbound/                # interfaces the app exposes (primary ports)
│   │       │   └── I<Component>Service.ts
│   │       └── outbound/               # interfaces the app depends on (secondary ports)
│   │           ├── I<Component>Repository.ts
│   │           └── I<ExternalService>.ts
│   │
│   ├── adapters/
│   │   ├── inbound/                    # primary adapters — drive the app
│   │   │   ├── http/
│   │   │   │   ├── server.ts
│   │   │   │   ├── <component>/
│   │   │   │   │   ├── <component>.router.ts
│   │   │   │   │   ├── <component>.controller.ts
│   │   │   │   │   ├── <component>.schema.ts
│   │   │   │   │   └── <component>.controller.test.ts
│   │   │   │   └── middleware/
│   │   │   └── consumers/              # message queue consumers (omit if unused)
│   │   │       └── <event>.consumer.ts
│   │   └── outbound/                   # secondary adapters — driven by the app
│   │       ├── persistence/
│   │       │   ├── postgres/           # real implementations
│   │       │   │   └── <component>.repository.ts
│   │       │   └── in-memory/          # fakes for tests
│   │       │       └── <component>.repository.fake.ts
│   │       └── <external-service>/
│   │           └── <service>.client.ts
│   │
│   ├── app.ts                          # composition root — wires domain + adapters
│   └── index.ts                        # entrypoint
│
└── tests/
    └── integration/
        └── <component>.test.ts
```

## Pragmatic layout (flatter — `presentation/` + `infrastructure/`)

Identical domain isolation rules. Only the directory names for the adapter layers change.

```
my-svc/
│
├── package.json
├── tsconfig.json
│
├── src/
│   ├── domain/                         # THE CORE — unchanged, same rules apply
│   │   ├── <component>/
│   │   │   ├── <component>.model.ts
│   │   │   ├── <component>.service.ts
│   │   │   └── <component>.service.test.ts
│   │   └── ports/                      # inbound + outbound interfaces (no sub-split needed)
│   │       ├── I<Component>Service.ts
│   │       ├── I<Component>Repository.ts
│   │       └── I<ExternalService>.ts
│   │
│   ├── presentation/                   # inbound adapters (replaces adapters/inbound/)
│   │   ├── http/
│   │   │   ├── server.ts
│   │   │   ├── <component>/
│   │   │   │   ├── <component>.router.ts
│   │   │   │   ├── <component>.controller.ts
│   │   │   │   ├── <component>.schema.ts
│   │   │   │   └── <component>.controller.test.ts
│   │   │   └── middleware/
│   │   └── consumers/                  # omit if unused
│   │       └── <event>.consumer.ts
│   │
│   ├── infrastructure/                 # outbound adapters (replaces adapters/outbound/)
│   │   ├── persistence/
│   │   │   ├── <component>.repository.ts       # real implementation
│   │   │   └── <component>.repository.fake.ts  # in-memory fake for tests
│   │   └── <external-service>/
│   │       └── <service>.client.ts
│   │
│   ├── app.ts                          # composition root — unchanged
│   └── index.ts
│
└── tests/
    └── integration/
        └── <component>.test.ts
```

## Monorepo placement

In a monorepo, each service lives under `services/<name>/` and consumes shared packages from `packages/`:

```
acme/
├── packages/
│   ├── domain-core/    # shared value objects, error types
│   ├── logger/
│   └── config/
└── services/
    └── my-svc/         # either layout above lives here
```
