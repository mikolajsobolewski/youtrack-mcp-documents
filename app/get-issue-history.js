const library = require('./lib');
exports.aiTool = {
  "name": "get_issue_history",
  "description": "Read historical changes via the activities API. Defaults to custom-field changes, including State. Follow nextOffset, preserving the returned end value on every subsequent page. start/end are Unix milliseconds.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "Readable or database ID returned by list_documents, e.g. DEMO-42 or 2-42."
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "default": 0
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 50
      },
      "start": {
        "type": "integer",
        "minimum": 0
      },
      "end": {
        "type": "integer",
        "minimum": 0
      },
      "categories": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "CustomFieldCategory",
            "CommentsCategory",
            "DescriptionCategory",
            "SummaryCategory",
            "IssueCreatedCategory",
            "LinksCategory",
            "TagsCategory"
          ]
        },
        "minItems": 1
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "annotations": {
    "title": "get issue history",
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {"schemaVersion": {"type": "integer"}},
    "additionalProperties": true
  }
};
exports.aiTool.execute = library.getIssueHistory;
