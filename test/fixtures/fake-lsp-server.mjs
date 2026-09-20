import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let buffer = Buffer.alloc(0);
const documents = new Map();
let workspacePath;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/iu.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
    buffer = buffer.subarray(bodyStart + length);
    handle(message);
  }
}

function handle(message) {
  const method = message.method;
  if (method === "initialize") {
    workspacePath = fileURLToPath(message.params.rootUri);
    respond(message.id, {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        hoverProvider: true,
        textDocumentSync: 1,
      },
    });
    return;
  }
  if (method === "shutdown") {
    respond(message.id, null);
    return;
  }
  if (method === "exit") {
    process.exit(0);
  }
  if (method === "textDocument/didOpen") {
    documents.set(message.params.textDocument.uri, message.params.textDocument.text);
    return;
  }
  if (method === "textDocument/didChange") {
    documents.set(message.params.textDocument.uri, message.params.contentChanges[0].text);
    return;
  }
  if (method === "textDocument/definition") {
    respond(message.id, {
      uri: message.params.textDocument.uri,
      range: range(0, 0, 0, 5),
    });
    return;
  }
  if (method === "textDocument/references") {
    respond(message.id, [{
      uri: message.params.textDocument.uri,
      range: range(0, 0, 0, 5),
    }]);
    return;
  }
  if (method === "textDocument/implementation") {
    respond(message.id, {
      targetUri: message.params.textDocument.uri,
      targetSelectionRange: range(0, 0, 0, 5),
    });
    return;
  }
  if (method === "textDocument/hover") {
    let workspaceWritable = true;
    try {
      writeFileSync(join(workspacePath, "lsp-must-stay-read-only.txt"), "forbidden");
    } catch {
      workspaceWritable = false;
    }
    const text = documents.get(message.params.textDocument.uri) ?? "";
    respond(message.id, {
      contents: {
        kind: "markdown",
        value: `snapshot=${text}; hostHomeVisible=${existsSync("/home")}; workspaceWritable=${workspaceWritable}`,
      },
      range: range(0, 0, 0, 5),
    });
    return;
  }
  if (message.id !== undefined) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "method not found" },
    });
  }
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
