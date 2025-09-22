# utils/schemas.py
from jsonschema import Draft7Validator

WINE_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": ["string", "number", "null"]},
        "name": {"type": ["string", "null"]},
        "wine": {"type": ["string", "null"]},
        "vintage": {"type": ["string", "number", "null"]},
        "full_type": {"type": ["string", "null"]},
        "region_group": {"type": ["string", "null"]},
        "stock": {"type": ["integer", "number", "null"]},
        "price_tier": {"type": ["string", "number", "null"]},
        "match_quality": {"type": ["string", "null"]},
        "avg_cpi_score": {"type": ["number", "string", "null"]},
        "locked": {"type": ["boolean", "null"]},
        "slot": {"type": ["integer", "null"]},
    },
    "additionalProperties": True
}

# Exactly 7 days, each is a 5-slot array of wine items or nulls
DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
def _day_array():
    return {
        "type": "array",
        "minItems": 5,
        "maxItems": 5,
        "items": {"anyOf": [{"type": "null"}, WINE_ITEM]}
    }

SCHEDULE_SCHEMA = {
    "type": "object",
    "properties": {d: _day_array() for d in DAYS},
    "required": DAYS,
    "additionalProperties": False
}

# Locked calendar has the same shape; just usually only locked slots are filled
LOCKED_SCHEMA = SCHEDULE_SCHEMA

ScheduleValidator = Draft7Validator(SCHEDULE_SCHEMA)
LockedValidator = Draft7Validator(LOCKED_SCHEMA)

def list_errors(validator, payload):
    return [f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in validator.iter_errors(payload)]
