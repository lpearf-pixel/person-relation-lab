import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 262_144;
const MAX_TOTAL_BYTES = 786_432;
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5-coder:7b-instruct";
const DEFAULT_OUTPUT = "/tmp/person-relation-local-coder-latest.md";
const ALLOWED_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".txt",
  ".yaml",
  ".yml"
]);
const PROTECTED_SEGMENTS = new Set([
  "backup",
  "backups",
  "data",
  "dump",
  "dumps",
  "import",
  "imports",
  "log",
  "logs",
  "node_modules"
]);

export interface ContextDocument {
  relativePath: string;
  content: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertUnprotected(relativePath: string): void {
  const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? "";
  if (basename === ".env" || basename.startsWith(".env.") || segments.some((part) => PROTECTED_SEGMENTS.has(part))) {
    throw new Error(`protected context path is not allowed: ${relativePath}`);
  }
}

export async function validateContextPath(repoRoot: string, candidate: string): Promise<string> {
  const resolvedRoot = await realpath(repoRoot);
  const requested = path.resolve(resolvedRoot, candidate);
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch {
    throw new Error(`context file does not exist: ${candidate}`);
  }
  if (!isInside(resolvedRoot, resolved)) {
    throw new Error(`context file is outside the repository: ${candidate}`);
  }
  const relative = path.relative(resolvedRoot, resolved);
  assertUnprotected(relative);
  const extension = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`context file extension is not allowed: ${extension || "none"}`);
  }
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error(`context path is not a regular file: ${candidate}`);
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`context file exceeds ${MAX_FILE_BYTES} bytes: ${candidate}`);
  }
  return resolved;
}

export function parseOllamaUrl(input: string): URL {
  const url = new URL(input);
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (url.protocol !== "http:" || !allowedHosts.has(url.hostname) || url.username || url.password) {
    throw new Error("OLLAMA_URL must be a local HTTP endpoint");
  }
  return url;
}

export function buildMessages(task: string, contexts: ContextDocument[]): ChatMessage[] {
  const system = [
    "You are a bounded coding assistant for Person Relation Lab.",
    "Use only the task and files supplied in this request.",
    "Do not request personal data, database contents, secrets, .env files, imports, dumps, spreadsheets, CSV files, or logs.",
    "Do not execute commands and do not claim that tests ran.",
    "Return a concise engineering answer. When code changes are requested, prefer a unified diff and list verification commands separately.",
    "Never infer or assert intimate relationships from personal records."
  ].join("\n");
  const files = contexts
    .map((document) => `FILE: ${document.relativePath}\n---\n${document.content}\n---`)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `TASK\n${task}\n\nCONTEXT FILES\n${files || "(none)"}` }
  ];
}

function apiUrl(base: URL, pathname: string): URL {
  return new URL(pathname, base);
}

function timeoutSignal(): AbortSignal {
  const raw = process.env.LOCAL_CODER_TIMEOUT_SECONDS ?? "120";
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error("LOCAL_CODER_TIMEOUT_SECONDS must be an integer from 1 to 900");
  }
  return AbortSignal.timeout(seconds * 1000);
}

async function requestJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: timeoutSignal() });
  if (!response.ok) {
    throw new Error(`Ollama request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function check(base: URL, model: string): Promise<void> {
  const tags = await requestJson<OllamaTagsResponse>(apiUrl(base, "/api/tags"));
  const available = (tags.models ?? []).map((entry) => entry.name ?? entry.model).filter(Boolean);
  if (!available.includes(model)) {
    throw new Error(`model is not installed: ${model}; run: ollama pull ${model}`);
  }
  const reply = await requestJson<OllamaChatResponse>(apiUrl(base, "/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly LOCAL_CODER_OK" }],
      options: { temperature: 0 }
    })
  });
  const content = reply.message?.content?.trim();
  if (!content) {
    throw new Error("Ollama returned an empty smoke-test response");
  }
  console.log(JSON.stringify({ event: "LOCAL_CODER_CHECK_OK", model, endpoint: base.origin, response: content }));
}

async function loadDocuments(repoRoot: string, candidates: string[]): Promise<ContextDocument[]> {
  const documents: ContextDocument[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const absolute = await validateContextPath(repoRoot, candidate);
    const content = await readFile(absolute, "utf8");
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`combined task and context exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    documents.push({ relativePath: path.relative(repoRoot, absolute), content });
  }
  return documents;
}

async function run(base: URL, model: string, args: string[]): Promise<void> {
  const taskCandidate = args[0];
  if (!taskCandidate) {
    throw new Error("usage: local-coder run <task-file> [context-file ...]");
  }
  const repoRoot = process.cwd();
  const taskPath = await validateContextPath(repoRoot, taskCandidate);
  const task = await readFile(taskPath, "utf8");
  const contexts = await loadDocuments(repoRoot, args.slice(1));
  const total = Buffer.byteLength(task) + contexts.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`combined task and context exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
  const reply = await requestJson<OllamaChatResponse>(apiUrl(base, "/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: buildMessages(task, contexts),
      options: { temperature: 0.1 }
    })
  });
  const content = reply.message?.content?.trim();
  if (!content) {
    throw new Error("Ollama returned an empty response");
  }
  const output = process.env.LOCAL_CODER_OUTPUT ?? DEFAULT_OUTPUT;
  if (!path.isAbsolute(output) || path.dirname(output) !== "/tmp") {
    throw new Error("LOCAL_CODER_OUTPUT must be a direct child of /tmp");
  }
  await writeFile(output, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ event: "LOCAL_CODER_OUTPUT_READY", model, output, contextFiles: contexts.length }));
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  const base = parseOllamaUrl(process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL);
  const model = process.env.LOCAL_CODER_MODEL ?? DEFAULT_MODEL;
  if (command === "check") {
    await check(base, model);
    return;
  }
  if (command === "run") {
    await run(base, model, argv.slice(1));
    return;
  }
  throw new Error("usage: local-coder <check|run> [arguments]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

