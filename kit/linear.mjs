#!/usr/bin/env node
// Linear, for agents and for the other scripts. No secret lives in this file:
// the API key comes from $LINEAR_API_KEY, or from the command named in
// factory.config.json (`tracker.keyCommand`, for a password manager's CLI).
//
//   node scripts/factory/linear.mjs issue APP-12                 read a ticket
//   node scripts/factory/linear.mjs board                        open tickets, with labels and blockers
//   node scripts/factory/linear.mjs create --title "…" [--description-file f.md] [--label "Small bug"]…
//   node scripts/factory/linear.mjs comment APP-12 --body-file review.md
//   node scripts/factory/linear.mjs label APP-12 --add "Plan reviewed" --remove "Plan written"
//   node scripts/factory/linear.mjs state APP-12 "In Progress"
//   node scripts/factory/linear.mjs query '<graphql>' ['<variables json>']
//
// Every command prints JSON. Exit 1 on any failure, with the reason on stderr.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, repoRoot } from './config.mjs';

const ENDPOINT = process.env.FACTORY_LINEAR_API || 'https://api.linear.app/graphql';

export function resolveKey(config, env = process.env) {
  const direct = env.LINEAR_API_KEY || env.LINEAR_KEY;
  if (direct) return direct.trim();
  const command = config?.tracker?.keyCommand;
  if (command) {
    try {
      const key = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (key) return key;
    } catch {
      // Fall through to the error below.
    }
  }
  throw new Error('No Linear API key: set LINEAR_API_KEY, or tracker.keyCommand in factory.config.json.');
}

/** One GraphQL call. `fetchImpl` is injectable so tests never reach Linear. */
export async function linear(query, variables, { key, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Linear returned a non-JSON response (${response.status}).`);
  }
  if (payload.errors?.length) throw new Error(`Linear rejected the request: ${payload.errors[0]?.message ?? 'unknown error'}`);
  if (!response.ok) throw new Error(`Linear answered ${response.status}.`);
  return payload.data;
}

const ISSUE_FIELDS = `id identifier title description url state { name type } labels { nodes { id name } } team { id key }`;

export async function getIssue(key, options) {
  const data = await linear(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: key }, options);
  if (!data?.issue) throw new Error(`Linear issue ${key} was not found.`);
  return data.issue;
}

export async function issueLabels(key, options) {
  return (await getIssue(key, options)).labels.nodes.map((label) => label.name);
}

export async function issueComments(key, options) {
  const data = await linear(
    'query($id: String!) { issue(id: $id) { identifier comments(first: 100) { nodes { body createdAt } } } }',
    { id: key },
    options,
  );
  const nodes = data?.issue?.comments?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`Linear issue ${key} was not found.`);
  return [...nodes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((node) => String(node.body ?? ''));
}

async function labelId(teamId, name, options) {
  const data = await linear(
    'query($name: String!) { issueLabels(filter: { name: { eq: $name } }, first: 50) { nodes { id name team { id } } } }',
    { name },
    options,
  );
  const nodes = data?.issueLabels?.nodes ?? [];
  const match = nodes.find((label) => label.team?.id === teamId) ?? nodes.find((label) => !label.team);
  if (!match) throw new Error(`Linear has no label "${name}" for this team. Create it in Linear first.`);
  return match.id;
}

/** Add and remove labels by name, keeping every other label. Reads the ticket back to confirm. */
export async function setLabels(key, { add = [], remove = [] }, options) {
  const issue = await getIssue(key, options);
  const ids = new Set(issue.labels.nodes.filter((label) => !remove.includes(label.name)).map((label) => label.id));
  for (const name of add) ids.add(await labelId(issue.team.id, name, options));
  await linear('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issue.id, input: { labelIds: [...ids] } }, options);
  return issueLabels(key, options);
}

export async function setState(key, stateName, options) {
  const issue = await getIssue(key, options);
  const data = await linear(
    'query($team: ID!, $name: String!) { workflowStates(filter: { team: { id: { eq: $team } }, name: { eq: $name } }) { nodes { id name } } }',
    { team: issue.team.id, name: stateName },
    options,
  );
  const state = data?.workflowStates?.nodes?.[0];
  if (!state) throw new Error(`Linear team ${issue.team.key} has no state "${stateName}".`);
  await linear('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issue.id, input: { stateId: state.id } }, options);
  return (await getIssue(key, options)).state.name;
}

export async function addComment(key, body, options) {
  const issue = await getIssue(key, options);
  await linear('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: issue.id, body } }, options);
  return { key: issue.identifier, commented: true };
}

export async function createIssue({ team, title, description = '', labels = [] }, options) {
  const data = await linear('query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }', { key: team }, options);
  const teamId = data?.teams?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`Linear has no team with key "${team}". Set tracker.team in factory.config.json.`);
  const labelIds = [];
  for (const name of labels) labelIds.push(await labelId(teamId, name, options));
  const created = await linear(
    'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier title url } } }',
    { input: { teamId, title, description, labelIds } },
    options,
  );
  if (!created?.issueCreate?.success) throw new Error('Linear did not create the issue.');
  return created.issueCreate.issue;
}

/**
 * Every open ticket of the team, with what scheduling needs: state, labels and
 * the tickets that block it. Pages until done; a short page is never presented
 * as the whole board.
 */
export async function board({ team, openStates = [] }, options) {
  const issues = [];
  let after = null;
  for (let page = 0; page < 50; page += 1) {
    const data = await linear(
      `query($team: String!, $after: String) {
        issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, state: { type: { in: ["started", "unstarted"] } } }) {
          nodes {
            identifier title url priority
            state { name type }
            labels { nodes { name } }
            inverseRelations { nodes { type issue { identifier state { type } } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { team, after },
      options,
    );
    const connection = data?.issues;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error('Linear returned no issue list; the board is incomplete.');
    for (const node of connection.nodes) {
      if (openStates.length > 0 && !openStates.includes(node.state.name)) continue;
      issues.push({
        key: node.identifier,
        title: node.title,
        url: node.url,
        priority: node.priority ?? 0,
        state: node.state.name,
        stateType: node.state.type,
        labels: node.labels.nodes.map((label) => label.name),
        // Only tickets still open block; a finished blocker no longer does.
        blockedBy: node.inverseRelations.nodes
          .filter((relation) => relation.type === 'blocks' && !['completed', 'canceled'].includes(relation.issue.state.type))
          .map((relation) => relation.issue.identifier),
      });
    }
    if (!connection.pageInfo.hasNextPage) return issues;
    after = connection.pageInfo.endCursor;
  }
  throw new Error('Linear board did not finish paging; refusing to present a partial board.');
}

function parseFlags(args) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), args[index + 1] ?? '']);
      index += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const config = loadConfig(repoRoot());
  const options = { key: resolveKey(config) };
  const { flags, positionals } = parseFlags(rest);
  const one = (name) => flags.get(name)?.at(-1);
  const fileOr = (fileFlag, textFlag) => (one(fileFlag) ? readFileSync(one(fileFlag), 'utf8') : one(textFlag) ?? '');
  const print = (value) => console.log(JSON.stringify(value, null, 2));

  switch (command) {
    case 'issue': return print(await getIssue(positionals[0], options));
    case 'board': return print(await board({ team: config.tracker.team, openStates: config.tracker.openStates }, options));
    case 'create': {
      if (!one('title')) throw new Error('create needs --title.');
      return print(await createIssue({ team: one('team') ?? config.tracker.team, title: one('title'), description: fileOr('description-file', 'description'), labels: flags.get('label') ?? [] }, options));
    }
    case 'comment': {
      const body = fileOr('body-file', 'body');
      if (!positionals[0] || !body.trim()) throw new Error('comment needs a ticket key and --body-file or --body.');
      return print(await addComment(positionals[0], body, options));
    }
    case 'label': return print(await setLabels(positionals[0], { add: flags.get('add') ?? [], remove: flags.get('remove') ?? [] }, options));
    case 'state': return print({ key: positionals[0], state: await setState(positionals[0], positionals.slice(1).join(' '), options) });
    case 'query': return print(await linear(positionals[0], positionals[1] ? JSON.parse(positionals[1]) : undefined, options));
    default:
      console.error('usage: linear.mjs issue <KEY> | board | create --title … | comment <KEY> --body-file … | label <KEY> --add … --remove … | state <KEY> <name> | query <graphql> [variables]');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`linear: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
