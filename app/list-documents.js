const library = require('./lib');
exports.aiTool = {
  "name": "list_documents",
  "description": "List issue or article metadata in one allowed project. Follow nextOffset until null. Enumeration is NOT an atomic snapshot: do not infer deletion from a partial or single unstable pass.",
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
      "project": {
        "type": "string"
      },
      "query": {
        "type": "string",
        "description": "Additional issue search expression. Not supported for articles: use project enumeration.",
        "maxLength": 1000
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
      }
    },
    "required": [
      "kind",
      "project"
    ],
    "additionalProperties": false
  },
  "annotations": {
    "title": "list documents",
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
exports.aiTool.execute = library.listDocuments;
