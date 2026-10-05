const library = require('./lib');
exports.aiTool = {
  "name": "get_comments",
  "description": "Read issue or article comments, including authors and timestamps. Follow nextOffset until null. Pagination is non-atomic; retry if the source changes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "issue",
          "article"
        ]
      },
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
      "expectedUpdatedAt": {
        "type": "integer",
        "description": "updatedAt returned by the first page. Abort and restart if it changed."
      }
    },
    "required": [
      "kind",
      "id"
    ],
    "additionalProperties": false
  },
  "annotations": {
    "title": "get comments",
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
exports.aiTool.execute = library.getComments;
