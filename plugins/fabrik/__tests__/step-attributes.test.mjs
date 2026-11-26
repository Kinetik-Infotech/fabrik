// A routine step's attributes, through the fabrik command's own page tools: draw_state_machine draws a design whose
// step holds confirmed_by, auto_for, cases and settings, the outline and the step's card name each one, and
// state_machine_payload gives the same attributes back from the page.
// Run with: node scripts/test.mjs plugins/fabrik/__tests__/step-attributes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../cli/lib/pages.mjs";

const PYTHON = [["python3"], ["python"], ["py", "-3"]].some(([cmd, ...rest]) => spawnSync(cmd, [...rest, "--version"]).status === 0);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);

const STEP = {
  reference: "R1.2", done_by: "claude_bounded", tool: "Accounts", has_tool: "yes", confirmed_by: "the owner",
  auto_for: ["owner@example.com"], cases: { customers: ["C001"], sources: [] },
  settings: { look_back_days: 30, channel: "#invoices" },
};
const RECORD = {
  cutoff: null, links: [],
  version: {
    record_id: "r1", version_id: "v1", version_number: 1, title: "Invoicing: proposed state",
    payload: {
      model_kind: "proposed_target", source_status: "proposed",
      graph: {
        nodes: [
          { id: "g", type: "routine", label: "Invoicing", attributes: { reference: "R1" } },
          { id: "a", type: "start", label: "Job done", attributes: { reference: "R1.1" } },
          { id: "b", type: "activity", label: "Draft the invoice", attributes: STEP },
          { id: "c", type: "end", label: "Invoice sent", attributes: { reference: "R1.3" } },
        ],
        edges: [
          { id: "e1", source: "a", target: "b", type: "flow", attributes: {} },
          { id: "e2", source: "b", target: "c", type: "flow", attributes: {} },
          ...["a", "b", "c"].map((id) => ({ id: `p-${id}`, source: id, target: "g", type: "part_of", attributes: {} })),
        ],
      },
    },
  },
};
const LINES = ["Done by: Claude, bounded", "Tool: Accounts", "Has the tool: yes", "Confirmed by: the owner",
  "Runs without asking for: owner@example.com", "Customers: C001", "Sources: every case",
  "Settings: channel: #invoices, look_back_days: 30"];

test("a step's attributes are drawn on its card and in the outline, and come back from the page unchanged", { skip: !PYTHON && "needs Python 3" }, async (t) => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-steps-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, "invoicing.record.json"), JSON.stringify(RECORD));
  const tools = createTools({ agentFolder: work });
  const call = async (name, args) => (await tools.callTool(name, args)).content[0].text;

  const drawn = await call("draw_state_machine", { record_file: join(work, "invoicing.record.json"), page_file: join(work, "invoicing.html") });
  assert.match(drawn, /invoicing\.html/, drawn);
  const outline = readFileSync(join(work, "invoicing.outline.md"), "utf-8");
  const step = outline.slice(outline.indexOf("- R1.2 Draft the invoice"), outline.indexOf("- R1.3"));
  assert.deepEqual(step.split("\n").slice(1).map((l) => l.trim()).filter(Boolean), LINES);

  const saved = await call("state_machine_payload", { page_file: join(work, "invoicing.html"), payload_file: join(work, "invoicing.payload.json") });
  assert.doesNotMatch(saved, /would not give the page back/, saved);
  const payload = JSON.parse(readFileSync(join(work, "invoicing.payload.json"), "utf-8"));
  const back = payload.graph.nodes.find((n) => n.id === "b").attributes;
  assert.deepEqual(back, STEP);
  assert.equal(back.page_overrides, undefined, "the step is drawn by the rules, with nothing kept as an override");

  if (!CHROME) return t.diagnostic("no Chromium browser: the card was not read");
  const page = readFileSync(join(work, "invoicing.html"), "utf-8");
  const probe = "<script>addEventListener('load',()=>setTimeout(()=>{graphPage.openDetails('b');const p=document.createElement('pre');" +
    "p.id='probe';p.textContent=document.getElementById('nodeDetailsBody').innerText;document.body.appendChild(p)},300))</script></body>";
  writeFileSync(join(work, "probe.html"), page.replace("</body>", probe));
  const dom = spawnSync(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${join(work, "profile")}`, "--virtual-time-budget=3000",
    "--dump-dom", `file://${join(work, "probe.html")}`], { encoding: "utf8", timeout: 60000 }).stdout;
  const card = (dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/) ?? [])[1] ?? "";
  for (const line of LINES) assert.ok(card.replace(/&amp;/g, "&").includes(line), `the card lacks "${line}":\n${card}`);
});
