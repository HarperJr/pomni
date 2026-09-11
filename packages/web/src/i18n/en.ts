/**
 * Every word the interface says, in English.
 *
 * This file is the source of truth in two senses: it is what renders when a translation is
 * missing, and its keys are the type every other dictionary is checked against. A key added
 * here and forgotten in `ru.ts` fails the build rather than appearing in Russian as English.
 *
 * Keys are named for where the words appear — `nav.projects`, `item.spec.save` — because the
 * question a translator and a reader both ask is "where does this show up". A key named for
 * the English sentence stops being true the moment the sentence is reworded.
 *
 * What is deliberately **not** here: anything a person or an agent wrote. Item titles and
 * bodies, agent output, run logs, repo names, ids, commands and statuses as the data spells
 * them (`in_review`, `blocked`) pass through untouched. Only the interface changes language.
 *
 * Placeholders are `{name}`, filled by `t()`. Counts go through `plural()` instead, because
 * Russian needs three forms where English needs two.
 */
export const en = {
  // -- shell ----------------------------------------------------------------
  'brand.tagline': 'project runtime',
  'nav.projects': 'Projects',
  'nav.tracker': 'Tracker',
  'nav.workflows': 'Workflows',
  'nav.tools': 'Tools',
  'nav.providers': 'Providers',
  'nav.credentials': 'Credentials',
  'nav.language': 'Language',
  'chat.open': 'Open chat',
  'chat.close': 'Close chat',

  // -- shared ---------------------------------------------------------------
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.remove': 'Remove',
  'common.edit': 'Edit',
  'common.preview': 'Preview',
  'common.add': 'Add',
  'common.none': 'none',
  'common.unknown': 'unknown',
  'common.showAll': 'Show all',
  'common.onlyActive': 'Only active',
  'common.retry': 'Try again',

  // -- projects -------------------------------------------------------------
  'projects.title': 'Projects',
  'projects.new': 'New project',
  'projects.empty': 'No projects yet. Add one to start tracking its backlog here.',
  'projects.repoCount': 'repos',
  'projects.openCount': 'open items',

  // -- the projects screen --------------------------------------------------
  'projects.create': 'Create',
  'projects.emptyLong':
    'No projects yet. A project is a container — create one, then add the repos it is built from.',
  'projects.noRepos': 'no repos',
  'projects.name': 'Name',
  'projects.nameHint': 'The id is derived from the name and never changes.',
  'projects.description': 'Description',
  'projects.nRunning': '{n} running|{n} running',

  // -- a project's blocks ---------------------------------------------------
  'block.repos': 'Repos',
  'block.backlog': 'Backlog',
  'block.runs': 'Agent runs',
  'block.checks': 'Checks',
  'block.workflows': 'Workflows',
  'block.discovery': 'Discovery',

  // -- repos ----------------------------------------------------------------
  'repo.sync': 'Sync',
  'repo.syncing': 'Syncing…',
  'repo.removeCloned': 'This deletes the cloned working copy.',
  'repo.removeLinked': 'Your folder is left untouched.',
  'repo.displayName': 'Display name',
  'repo.role': 'Role',
  'repo.credential': 'Credential',
  'repo.credentialAuto': 'Match by host / public repo',
  'repo.branch': 'Branch or tag',
  'repo.branchPlaceholder': 'default branch',
  'repo.forge': 'Forge',
  'repo.forgeOther': 'Other',
  'repo.url': 'Repository URL',

  // -- credentials ----------------------------------------------------------
  'credentials.title': 'Credentials',
  'credentials.empty': 'No credentials. Public repos work without one.',
  'credentials.add': 'Add credential',
  'credentials.name': 'Name',
  'credentials.namePlaceholder': 'GitHub personal',
  'credentials.provider': 'Provider',
  'credentials.host': 'Host',
  'credentials.username': 'Username',
  'credentials.usernameOptional': 'Username (optional)',
  'credentials.tokenSource': 'Where the token comes from',
  'credentials.fromEnv': 'Environment variable — nothing stored',
  'credentials.fromFile': 'Store in Pomni (gitignored file)',
  'credentials.forgetHint': 'The token Pomni was storing will be forgotten.',
  'credentials.variableName': 'Variable name',
  'credentials.token': 'Token',
  'credentials.replaceToken': 'Replace token',

  // -- tracker --------------------------------------------------------------
  'tracker.title': 'Tracker',
  'tracker.backlog': 'Backlog',
  'tracker.noProjects': 'Nothing to track until a project exists.',
  'tracker.emptyAll': 'This project has nothing in its backlog yet.',
  'tracker.emptyActive': 'This project has nothing open right now.',

  // -- the board ------------------------------------------------------------
  'board.move': 'Move…',
  'board.nowhere': 'nowhere from here',
  'board.blocked': 'blocked',
  'board.readyFor': 'ready for {state}',
  'board.waiting': 'waiting',
  'board.waitingOn': 'waiting on {items}',
  'board.wave': 'wave {n}',
  'board.offFlow': '{state} (off flow)',

  // -- the runs panel -------------------------------------------------------
  'runs.title': 'Agent runs',
  'runs.start': 'Run a task',
  'runs.startDisabled': 'no attached workflow is ready to run',
  'runs.emptyNoWorkflow':
    'Attach a workflow whose agents all have prompts, then a task can be run through it.',
  'runs.emptyNoRuns': 'Nothing has run yet. Give the pipeline a task and watch it work.',
  'runs.running': 'Running',
  'runs.recent': 'Recent',
  'runs.showLess': 'Show less',
  'runs.runAgain': 'Run again',
  'runs.rerunTitle': 'Run it again, telling the agents how this attempt ended',
  'runs.planning': 'Waiting for the orchestrator to plan the work…',
  'runs.tree': 'Show the delegation tree',
  'runs.doneOf': '{done} of {total} done',
  'runs.working': 'working: {agents}',

  // -- starting a run -------------------------------------------------------
  'start.title': 'Run a task',
  'start.go': 'Start',
  'start.fromBacklog': 'From the backlog',
  'start.describe': 'Describe it',
  'start.item': 'Item',
  'start.chooseItem': 'Choose an item…',
  'start.itemHint':
    'Its problem and acceptance criteria become the task. The item moves to in progress when the run starts, and to in review if the gate passes afterwards.',
  'start.task': 'Task',
  'start.taskPlaceholder':
    'Users cannot reset their password when their email has changed. Work out what we should build.',
  'start.taskHint':
    'Written for the orchestrator, which decides who to involve. Give it the problem, not the plan.',
  'start.workflow': 'Workflow',
  'start.workflowAuto': 'Choose from the task',
  'start.workflowHint': 'Left automatic, the workflow whose hints match the task wins.',
  'start.context': 'Context files',
  'start.contextHint':
    'Text files — a spec, a log, a schema. Every agent in the workflow is given them, so attach what the work needs and not the whole repo.',
  'start.removeFile': 'Remove {name}',

  // -- watching a run -------------------------------------------------------
  'console.stop': 'Stop',
  'console.resume': 'Resume',
  'console.resuming': 'Resuming…',
  'console.resumeTitle':
    'Carry on from what it already did, in the same worktree. Finished steps are not paid for twice.',
  'console.runAgainTitle': 'Start again from the task, telling the agents how this attempt ended',
  'console.starting': 'Starting…',
  'console.resumeNote': 'Fixed something yourself? Say what, and Resume will tell the agents.',
  'console.agents': 'Agents',
  'console.transcript': 'Transcript',
  'console.waitingForOrchestrator': 'Waiting for the orchestrator…',
  'console.transcriptEmpty':
    'Output appears here as each agent replies. Click an agent to see only its turn.',
  'console.noReplyYet': 'This agent has not replied yet.',
  'console.refused': 'The permission layer turned this away',
  'console.result': 'Result',
  'console.failed': 'Failed',
  'console.outcome.partial': 'did some of it',
  'console.outcome.blocked': 'could not do it',
  'console.outcome.unknown': 'did not say whether it worked',
  'console.answerPlaceholder': 'Your answer — a sentence is usually enough.',
  'console.answer': 'Answer',
  'console.sending': 'Sending…',

  // -- runs -----------------------------------------------------------------
  'run.branch.delivered': 'the branch this run delivered on',
  'run.branch.live': 'the worktree this run is working in',
  'run.branch.inRepo': 'in repo',
  'run.branch.inRepoWhy': 'no worktree could be cut; the run used the repo directory itself',
  'run.artifacts': 'Artifacts',
  'run.artifacts.openMr': 'Open a merge request',
  'run.artifacts.mr': 'merge request',
  'run.artifacts.branch': 'branch {name}',
  'run.diff.reading': 'reading the diff…',
  'run.diff.unchanged': 'nothing changed here',
  'run.diff.unchangedOnBranch': 'nothing changed here on the run’s branch',
  'run.diff.truncated': '…truncated — this is the first part of a longer diff',
  'run.diff.fromWorktree': 'uncommitted, in the worktree this run is using',
  'run.diff.fromBranch': 'as committed on this run’s branch',
  'run.file.openForge': 'Open on the forge',
  'run.file.openEditor': 'Open in {editor}',
  'run.file.openEditorWhy': 'opens it with {editor} on the machine running Pomni',
  'run.file.noEditor': 'no editor found',
  'run.file.noEditorWhy': "set one with 'pomni editor <command>'",
  'run.file.reveal': 'Reveal in folder',
} as const;

export type Dictionary = Record<keyof typeof en, string>;
