"""OpenTelemetry tracing for the workflow-agent.

Exports to the same Zipkin endpoint Dapr's sidecars use, with the default W3C tracecontext
propagator — so the FastAPI server span (the trace root, since the triggering curl carries no
context) and the httpx-propagated MCP tool calls join the one Dapr trace tree.
"""

import os

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.zipkin.json import ZipkinExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def init_tracing(app: FastAPI, service_name: str) -> None:
    endpoint = os.getenv("ZIPKIN_ENDPOINT", "http://localhost:9411/api/v2/spans")

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(ZipkinExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)

    # Server spans for inbound requests (roots the trace) and traceparent injection on the MCP
    # client's outbound httpx calls, so the workflow-mcp step continues this trace.
    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()
