#!/usr/bin/env node
// Evaluate JavaScript in the pages of a WebKitGTK process through its remote
// inspector's HTTP server (WEBKIT_INSPECTOR_HTTP_SERVER=host:port), which
// speaks the inspector protocol over a WebSocket per page. This reads the
// page chan-desktop really shows, in the engine it really runs in.
//
//   inspect.mjs <host:port> list
//   inspect.mjs <host:port> eval <title-substring> <expression>
//   inspect.mjs <host:port> all <expression>
//
// `eval` prints the expression's value as JSON on stdout. Exit 0 on a value,
// 1 when the page threw, 2 when no page matched or the inspector did not
// answer. `all` evaluates in every page and prints one JSON line per page,
// its listing text beside its value or its error, and exits 0.
const [, , endpoint, command, ...rest] = process.argv;

async function targets() {
  const html = await (await fetch(`http://${endpoint}/`, { signal: AbortSignal.timeout(5000) })).text();
  const found = [];
  // Each inspectable page is a link to the bundled inspector whose query
  // names the page's socket, beside the page's title and URL.
  const row = /<tr[^>]*>(.*?)<\/tr>/gs;
  for (const [, cells] of html.matchAll(row)) {
    const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
    if (!path) continue;
    const text = cells.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    found.push({ socket: `${endpoint}${path}`, text });
  }
  return { found, html };
}

function evaluate(socket, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${socket}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error("inspector did not answer in 8s")); }, 8000);
    let page = null;
    const send = (target) => {
      const inner = JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
      ws.send(JSON.stringify({ id: 1, method: "Target.sendMessageToTarget", params: { targetId: target, message: inner } }));
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !page) {
        page = message.params.targetInfo.targetId;
        send(page);
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        if (inner.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        resolve(inner);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach ws://${socket}`)); };
  });
}

try {
  const { found, html } = await targets();
  if (command === "list") {
    for (const target of found) console.log(JSON.stringify(target));
    if (!found.length) console.error(html.slice(0, 2000));
    process.exit(found.length ? 0 : 2);
  }
  if (command === "all") {
    for (const target of found) {
      try {
        const answer = await evaluate(target.socket, rest[0]);
        console.log(JSON.stringify({ page: target.text, value: answer.result?.result?.value ?? null, thrown: Boolean(answer.error || answer.result?.wasThrown) }));
      } catch (error) {
        console.log(JSON.stringify({ page: target.text, error: String(error) }));
      }
    }
    process.exit(0);
  }
  const [title, expression] = rest;
  const target = found.find((entry) => entry.text.includes(title));
  if (!target) {
    console.error(`no inspectable page matches ${JSON.stringify(title)}; pages: ${found.map((entry) => entry.text).join(" | ")}`);
    process.exit(2);
  }
  const answer = await evaluate(target.socket, expression);
  if (answer.error || answer.result?.wasThrown) {
    console.error(JSON.stringify(answer));
    process.exit(1);
  }
  console.log(JSON.stringify(answer.result.result.value));
} catch (error) {
  console.error(String(error));
  process.exit(2);
}
