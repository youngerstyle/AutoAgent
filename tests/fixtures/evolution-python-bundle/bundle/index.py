import json


def health(context):
    return {"ok": True}


def invoke_tool(name, input_value, context):
    return {"name": name, "echo": json.dumps(input_value, sort_keys=True)}
