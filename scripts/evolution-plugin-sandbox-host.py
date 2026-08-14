#!/usr/bin/env python3
"""Trusted protocol shim executed inside the OS sandbox, never on the host directly."""

import asyncio
import importlib.util
import inspect
import json
import resource
import sys
from types import SimpleNamespace


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def receive():
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("sandbox protocol input closed")
    return json.loads(line)


def bounded_resources():
    limits = [
        (resource.RLIMIT_AS, 256 * 1024 * 1024),
        (resource.RLIMIT_CPU, 20),
        (resource.RLIMIT_NPROC, 16),
        (resource.RLIMIT_NOFILE, 64),
        (resource.RLIMIT_FSIZE, 1024 * 1024),
        (resource.RLIMIT_CORE, 0),
    ]
    for kind, value in limits:
        resource.setrlimit(kind, (value, value))


def resolve(value):
    return asyncio.run(value) if inspect.isawaitable(value) else value


class Context(SimpleNamespace):
    def request_capability(self, capability, input_value):
        self._sequence += 1
        request_id = f"cap-{self._sequence}"
        send({"type": "capability_request", "requestId": request_id, "capability": capability, "input": input_value})
        response = receive()
        if response.get("type") != "capability_result" or response.get("requestId") != request_id:
            raise RuntimeError("capability protocol response mismatch")
        if not response.get("ok"):
            raise RuntimeError(response.get("error") or "capability request failed")
        return response.get("result")


def load_extension(entrypoint):
    spec = importlib.util.spec_from_file_location("autoagent_evolution_extension", entrypoint)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load extension entrypoint")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call_optional(module, name, *args):
    function = getattr(module, name, None)
    return resolve(function(*args)) if callable(function) else None


def main():
    bounded_resources()
    message = receive()
    if message.get("type") != "invoke":
        raise RuntimeError("expected invoke message")
    context = Context(**message.get("context", {}), _sequence=0)
    extension = load_extension(sys.argv[1])
    try:
        call_optional(extension, "activate", context)
        health = call_optional(extension, "health", context)
        if health is not None and (not isinstance(health, dict) or health.get("ok") is not True):
            raise RuntimeError("extension health check failed")
        if message.get("operation") == "tool":
            function = getattr(extension, "invoke_tool", None)
            if not callable(function):
                raise RuntimeError("extension does not export invoke_tool")
            result = resolve(function(message.get("name"), message.get("input"), context))
        else:
            function = getattr(extension, "guard", None)
            if not callable(function):
                raise RuntimeError("extension does not export guard")
            result = resolve(function(message.get("name"), message.get("phase"), message.get("tool"), message.get("input"), message.get("output"), context))
        call_optional(extension, "deactivate", context)
        send({"type": "result", "requestId": message.get("requestId"), "result": result})
    except Exception as error:
        try:
            call_optional(extension, "deactivate", context)
        except Exception:
            pass
        send({"type": "result", "requestId": message.get("requestId"), "error": str(error)[:4000]})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        send({"type": "fatal", "error": str(error)[:4000]})
