// The squad-author agent's configuration stays in step with the runtime: one prompt for both agent runtimes, the
// permissions that let it use the squad tools and nothing else, and a prompt that names the tools that exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMcpServer } from '../src/http/mcp';
import type { Authoring } from '../src/authoring';

const agentDir = fileURLToPath(new URL('../agent/', import.meta.url));
const read = (p: string): string => readFileSync(join(agentDir, p), 'utf8').replace(/\r\n/g, '\n');

test('the Claude Code agent body is exactly prompts/squad-author.md', () => {
  const agent = read('claude-code/.claude/agents/squad-author.md');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(agent);
  assert.ok(m, 'frontmatter');
  assert.match(m![1]!, /^name: squad-author$/m);
  assert.match(m![1]!, /^tools: mcp__squad__\*$/m);
  assert.equal(m![2], read('prompts/squad-author.md'));
});

test('permissions: the squad tools only', () => {
  const settings = JSON.parse(read('claude-code/settings.json'));
  assert.deepEqual(settings.permissions.allow, ['mcp__squad']);
  for (const t of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Agent']) assert.ok(settings.permissions.deny.includes(t), t);
  const mcp = JSON.parse(read('claude-code/.mcp.json'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['squad']);
  assert.match(mcp.mcpServers.squad.url, /\/mcp\/squad$/);
  assert.equal(mcp.mcpServers.squad.headers.Authorization, 'Bearer ${PAULSBRAWLS_SQUAD_TOKEN}');
  const oc = JSON.parse(read('opencode.json'));
  assert.deepEqual(oc.agent['squad-author'].permission, { '*': 'deny', 'squad_*': 'allow' });
  assert.equal(oc.agent['squad-author'].prompt, '{file:./prompts/squad-author.md}');
});

test('the prompt names every MCP tool, and only those', () => {
  const server = buildMcpServer({} as Authoring);
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  assert.deepEqual(tools, ['check_script', 'get_api_reference', 'get_context', 'list_commands', 'read_command', 'submit_command', 'trial_run']);
  const prompt = read('prompts/squad-author.md');
  for (const t of tools) assert.ok(prompt.includes('`' + t + '`'), `prompt does not mention ${t}`);
});
