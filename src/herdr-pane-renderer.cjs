/**
 * Persistent output bridge launched inside a Herdr pane by HerdrCliApi.
 *
 * It listens on the per-pane Unix socket or Windows named pipe passed as argv[2].
 * The extension sends newline-delimited JSON: `ping` probes the bridge, while
 * `append` writes its text to stdout (inherited from the pane) before acknowledging.
 * `reset` clears scrollback and the screen before a display slot changes occupants.
 * This keeps transcript contents off the pane's shell command line after startup.
 */
const net = require("node:net");
const fs = require("node:fs");

const socketPath = process.argv[2];
if (typeof socketPath !== "string" || socketPath.length === 0) {
	process.stderr.write("durable-subagents: missing Herdr renderer socket path\n");
	process.exit(1);
}

if (process.platform !== "win32") {
	try {
		fs.unlinkSync(socketPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

const server = net.createServer((socket) => {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffered += chunk;
		let newline;
		while ((newline = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			handleMessage(socket, line);
		}
	});
});

function handleMessage(socket, line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return socket.end(JSON.stringify({ ok: false, error: "invalid message" }) + "\n");
	}
	if (typeof message?.id !== "string") {
		return socket.end(JSON.stringify({ ok: false, error: "missing message id" }) + "\n");
	}
	if (message.type === "ping") {
		return socket.end(JSON.stringify({ id: message.id, ok: true }) + "\n");
	}
	if (message.type !== "reset" && (message.type !== "append" || typeof message.text !== "string")) {
		return socket.end(JSON.stringify({ id: message.id, ok: false, error: "invalid output message" }) + "\n");
	}
	const text = message.type === "reset" ? "\x1b[3J\x1b[2J\x1b[H" : message.text;
	process.stdout.write(text, (error) => {
		socket.end(JSON.stringify({ id: message.id, ok: error === null || error === undefined, ...(error ? { error: error.message } : {}) }) + "\n");
	});
}

server.on("error", (error) => {
	process.stderr.write(`durable-subagents: Herdr renderer failed: ${error.message}\n`);
	process.exit(1);
});

server.listen(socketPath, () => {
	if (process.platform !== "win32") {
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch {
			// The socket can still be used if the platform does not allow chmod.
		}
	}
});

function cleanup() {
	if (server.listening) server.close();
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(socketPath);
		} catch {
			// The socket may already have been removed.
		}
	}
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
