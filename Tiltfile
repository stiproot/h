# Infra
k8s_yaml('k8s/infra/redis.yaml')

# Dapr components + Configuration
k8s_yaml([
    'k8s/dapr/statestore.yaml',
    'k8s/dapr/pubsub.yaml',
    'k8s/dapr/secretstore.yaml',
    'k8s/dapr/conversationstore.yaml',
    'k8s/dapr/claude.yaml',
    'k8s/dapr/resiliency.yaml',
    'k8s/dapr/appconfig.yaml',
])

# Secrets (gitignored — generate with: cli/scripts/gen-k8s-secrets.sh)
k8s_yaml('k8s/secrets/app-secrets.yaml')

# App images
IGNORE = [
    'node_modules',
    '**/node_modules',
    '**/dist',
    '.git',
    'output',
    'dapr-etcd',
    'secrets',
    'k8s',
    '.tiltignore',
    '**/.venv',
    '**/__pycache__',
    '**/*.pyc',
]

docker_build(
    'h/workflow-svc',
    '.',
    dockerfile='apps/workflow-svc/Dockerfile',
    ignore=IGNORE,
)

docker_build(
    'h/claude-agent',
    '.',
    dockerfile='apps/claude-agent/Dockerfile',
    ignore=IGNORE,
)

# App manifests
k8s_yaml([
    'k8s/apps/workflow-svc.yaml',
    'k8s/apps/claude-agent.yaml',
])

# Resource grouping and port forwards
k8s_resource(
    'redis',
    labels=['infra'],
    port_forwards=['6379:6379'],
)

k8s_resource(
    'workflow-svc',
    labels=['agents'],
    port_forwards=['8003:8000', '3503:3500'],
    resource_deps=['redis'],
)

k8s_resource(
    'claude-agent',
    labels=['agents'],
    port_forwards=['8002:8000'],
    resource_deps=['redis'],
)
