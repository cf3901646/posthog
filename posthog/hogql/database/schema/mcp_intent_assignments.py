from posthog.hogql.context import HogQLContext
from posthog.hogql.database.models import (
    DateDatabaseField,
    DateTimeDatabaseField,
    FieldOrTable,
    FloatDatabaseField,
    IntegerDatabaseField,
    StringDatabaseField,
    Table,
)

from products.mcp_analytics.backend.facade.clickhouse_schema import (
    MCP_INTENT_ASSIGNMENTS_DISTRIBUTED_TABLE,
    MCP_INTENT_CALLS_HOURLY_DISTRIBUTED_TABLE,
    MCP_INTENT_TOPIC_DAILY_DISTRIBUTED_TABLE,
)

MCP_INTENT_ASSIGNMENTS_FIELDS: dict[str, FieldOrTable] = {
    "team_id": IntegerDatabaseField(name="team_id", nullable=False),
    "intent_hash": StringDatabaseField(
        name="intent_hash",
        nullable=False,
        description="sha256 hex of the raw `$mcp_intent` text; join to events with sha256(toString(properties.$mcp_intent)).",
    ),
    "run_id": StringDatabaseField(name="run_id", nullable=False, description="Pipeline run that wrote the row."),
    "topic_id": StringDatabaseField(
        name="topic_id", nullable=True, description="Assigned intent topic id; NULL when no topic was within reach."
    ),
    "distance": FloatDatabaseField(
        name="distance", nullable=False, description="Cosine distance to the assigned topic centroid."
    ),
    "x": FloatDatabaseField(name="x", nullable=False, description="2D map position."),
    "y": FloatDatabaseField(name="y", nullable=False, description="2D map position."),
    "is_outlier": IntegerDatabaseField(
        name="is_outlier", nullable=False, description="1 when the intent sits outside its topic's outlier distance."
    ),
    "intent_text": StringDatabaseField(
        name="intent_text", nullable=False, description="Truncated intent text for display."
    ),
    "calls_in_run": IntegerDatabaseField(
        name="calls_in_run", nullable=False, description="Calls carrying this intent when it was embedded."
    ),
    "tool": StringDatabaseField(
        name="tool", nullable=False, description="Top tool for this intent when it was embedded."
    ),
    "timestamp": DateTimeDatabaseField(
        name="timestamp", nullable=False, description="When the assignment was made; the newest row per intent wins."
    ),
}


class MCPIntentAssignmentsTable(Table):
    description: str = (
        "Latest intent topic assignment per MCP tool intent text. Join to `events` on "
        "sha256(toString(properties.$mcp_intent)) = intent_hash to break tool calls down by intent topic."
    )
    fields: dict[str, FieldOrTable] = MCP_INTENT_ASSIGNMENTS_FIELDS

    def to_printed_clickhouse(self, context: HogQLContext):
        return MCP_INTENT_ASSIGNMENTS_DISTRIBUTED_TABLE

    def to_printed_hogql(self):
        return "mcp_intent_assignments"


MCP_INTENT_CALLS_HOURLY_FIELDS: dict[str, FieldOrTable] = {
    "team_id": IntegerDatabaseField(name="team_id", nullable=False),
    "hour": DateTimeDatabaseField(name="hour", nullable=False, description="Start of the hour, UTC."),
    "intent_hash": StringDatabaseField(
        name="intent_hash", nullable=False, description="sha256 hex of the raw intent text."
    ),
    "tool": StringDatabaseField(name="tool", nullable=False, description="Effective tool name."),
    "calls": IntegerDatabaseField(name="calls", nullable=False),
    "sessions": IntegerDatabaseField(name="sessions", nullable=False, description="Distinct MCP conversations."),
    "inserted_at": DateTimeDatabaseField(name="inserted_at", nullable=False),
}


class MCPIntentCallsHourlyTable(Table):
    description: str = "Hourly MCP tool calls per intent text and tool, written by the intent topics sync run."
    fields: dict[str, FieldOrTable] = MCP_INTENT_CALLS_HOURLY_FIELDS

    def to_printed_clickhouse(self, context: HogQLContext):
        return MCP_INTENT_CALLS_HOURLY_DISTRIBUTED_TABLE

    def to_printed_hogql(self):
        return "mcp_intent_calls_hourly"


MCP_INTENT_TOPIC_DAILY_FIELDS: dict[str, FieldOrTable] = {
    "team_id": IntegerDatabaseField(name="team_id", nullable=False),
    "day": DateDatabaseField(name="day", nullable=False),
    "tool": StringDatabaseField(name="tool", nullable=False, description="Effective tool name."),
    "topic_id": StringDatabaseField(
        name="topic_id", nullable=False, description="Intent topic id; empty when the intent had no topic yet."
    ),
    "calls": IntegerDatabaseField(name="calls", nullable=False),
    "sessions": IntegerDatabaseField(name="sessions", nullable=False),
    "outlier_calls": IntegerDatabaseField(name="outlier_calls", nullable=False),
    "intents": IntegerDatabaseField(name="intents", nullable=False, description="Distinct intent texts."),
    "inserted_at": DateTimeDatabaseField(name="inserted_at", nullable=False),
}


class MCPIntentTopicDailyTable(Table):
    description: str = (
        "Daily MCP tool calls per tool and intent topic. The fast path for intent topic trends; "
        "join topic_id to the topic registry for labels."
    )
    fields: dict[str, FieldOrTable] = MCP_INTENT_TOPIC_DAILY_FIELDS

    def to_printed_clickhouse(self, context: HogQLContext):
        return MCP_INTENT_TOPIC_DAILY_DISTRIBUTED_TABLE

    def to_printed_hogql(self):
        return "mcp_intent_topic_daily"
