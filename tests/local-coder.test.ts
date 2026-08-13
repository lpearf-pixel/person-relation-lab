import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  buildMessages,
  parseOllamaUrl,
  validateContextPath,
  type ContextDocument
} from "../src/tools/local-coder.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "person-relation-local-coder-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "src", "example.ts"), "export const answer = 42;\n");
  await writeFile(path.join(root, "task.md"), "Add a tested parser.\n");
  await writeFile(path.join(root, ".env"), "DATABASE_URL=secret\n");
  await writeFile(path.join(root, "data", "people.csv"), "name,id\nAlice,1\n");
  return root;
}

it("accepts an explicit small source file inside the repository", async () => {
  const root = await makeRepo();
  await expect(validateContextPath(root, "src/example.ts")).resolves.toBe(
    path.join(root, "src", "example.ts")
  );
});

it.each([".env", "data/people.csv"])("rejects protected context path %s", async (candidate) => {
  const root = await makeRepo();
  await expect(validateContextPath(root, candidate)).rejects.toThrow(/protected|not allowed/i);
});

it("rejects paths outside the repository", async () => {
  const root = await makeRepo();
  const outside = path.join(path.dirname(root), "outside.ts");
  await writeFile(outside, "export {};\n");
  await expect(validateContextPath(root, outside)).rejects.toThrow(/outside/i);
});

it("rejects unsupported and oversized context files", async () => {
  const root = await makeRepo();
  await writeFile(path.join(root, "archive.bin"), "binary");
  await writeFile(path.join(root, "src", "large.ts"), "x".repeat(262_145));
  await expect(validateContextPath(root, "archive.bin")).rejects.toThrow(/extension/i);
  await expect(validateContextPath(root, "src/large.ts")).rejects.toThrow(/262144 bytes/i);
});

it("builds a bounded prompt that forbids data access and command execution", () => {
  const contexts: ContextDocument[] = [
    { relativePath: "src/example.ts", content: "export const answer = 42;\n" }
  ];
  const messages = buildMessages("Add a unit test.", contexts);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.content).toContain("Do not request personal data");
  expect(messages[0]?.content).toContain("Do not execute commands");
  expect(messages[1]?.content).toContain("TASK\nAdd a unit test.");
  expect(messages[1]?.content).toContain("FILE: src/example.ts");
});

it("only accepts a local HTTP Ollama endpoint", () => {
  expect(parseOllamaUrl("http://127.0.0.1:11434").toString()).toBe("http://127.0.0.1:11434/");
  expect(parseOllamaUrl("http://localhost:11434").hostname).toBe("localhost");
  expect(() => parseOllamaUrl("https://ollama.example.com")).toThrow(/local HTTP/i);
  expect(() => parseOllamaUrl("http://192.168.1.20:11434")).toThrow(/local HTTP/i);
});

