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

  // -- chat -----------------------------------------------------------------
  'chat.title': 'Chat',
  'chat.new': 'New chat',
  'chat.untitled': 'Untitled chat',
  'chat.empty': 'No conversations yet. Start one to talk to Pomni.',
  'chat.delete': 'Delete',
  'chat.confirmDelete': 'Delete chat "{title}"?',
  'chat.pickProvider': 'Provider…',
  'chat.pickModel': 'Model…',
  'chat.startIt': 'Say something below to start it.',
  'chat.nextTurn': 'Applies to the next turn.',
  'chat.placeholder': 'Message Pomni…',
  'chat.saySomething': 'Say something to get started.',
  'chat.rename': 'Rename',
  'chat.you': 'You',
  'chat.assistant': 'Assistant',
  'chat.confirm': 'Confirm',
  'chat.reject': 'Reject',
  'chat.send': 'Send',
  'chat.sending': 'Sending…',
  'chat.addressRule':
    'Type #project, @agent or /skill at the start of a word — after a space or a new line. @ may take a workflow/agent form; # and / may not contain a slash; anything inside backticks is left alone.',

  // -- shared ---------------------------------------------------------------
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  // -- comments -------------------------------------------------------------
  'comments.title': 'Notes',
  'comments.none': 'Nothing written here yet.',
  'comments.placeholder': 'What should the next attempt know?',
  'comments.author': 'Your name',
  'comments.addressedTo': 'Ask someone (optional)',
  'comments.write': 'Write',
  'comments.person': '(person)',
  'comments.waiting': 'waiting',
  'comments.answered': 'answered',
  'comments.withdraw': 'Withdraw',
  'comments.withdrawn': 'Withdrawn.',
  'comments.attached': 'Attached',
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

  // -- adding a repo --------------------------------------------------------
  'addRepo.title': 'Add a repo',
  'addRepo.adding': 'Adding…',
  'addRepo.cloneAndAdd': 'Clone and add',
  'addRepo.fromGit': 'Clone from git',
  'addRepo.fromLocal': 'Link a local folder',
  'addRepo.urlHint':
    'Cloned into the project workspace. Use an https url to authenticate with a token.',
  'addRepo.forgeAuto': 'Detect automatically',
  'addRepo.forgeHint':
    'Detected from the hostname, and for a self-hosted forge by asking the server. Set it explicitly if the guess is wrong — it decides the username a token is sent with.',
  'addRepo.folder': 'Folder',
  'addRepo.linkedInPlace': 'Linked in place — Pomni never moves or copies your code.',
  'addRepo.hideBrowser': 'hide browser',
  'addRepo.browse': 'browse…',
  'addRepo.noCommands': 'no commands found',
  'addRepo.namePlaceholder': 'derived from the source',
  'addRepo.noSecret': ' — no secret',

  // -- the graph ------------------------------------------------------------
  'graph.empty': 'Add an orchestrator and the graph appears here.',

  // -- a capability run -----------------------------------------------------
  'checks.failedTests': 'Failed tests',
  'checks.verify': 'Verify',
  'checks.runTheGate': 'Run the gate',
  'checks.runDefaultGate': 'Run default gate',
  'checks.runLandGate': 'Run land gate instead',
  'checks.doctor': 'Doctor',
  'checks.checking': 'Checking…',

  // -- what the repos already contain ---------------------------------------
  'discovery.title': 'In the repos',
  'discovery.scan': 'Scan',
  'discovery.hide': 'Hide',
  'discovery.scanning': 'Scanning…',
  'discovery.idle':
    "Scan the project's repos for agent definitions, skills, commands and house rules that are already checked in.",
  'discovery.showMore': 'Show {n} more',
  'discovery.import': 'Import {name}',
  'discovery.importGo': 'Import',
  'discovery.intoWorkflow': 'Into which workflow',
  'discovery.choose': 'Choose…',
  'discovery.importHint':
    "The definition's own text becomes the agent's prompt, and its description becomes the spec — so you can regenerate later without losing what it was for.",
  'discovery.kind.agent': 'Agents',
  'discovery.kind.skill': 'Skills',
  'discovery.kind.command': 'Commands',
  'discovery.kind.rules': 'House rules',
  'discovery.hint.agent':
    'Subagent definitions already checked into the repo. Import one and its own text becomes the prompt.',
  'discovery.hint.skill':
    'Packaged instructions the repo already carries. Useful context when writing an agent that works there.',
  'discovery.hint.command': 'Slash commands defined in the repo.',
  'discovery.hint.rules':
    "The repo's own CLAUDE.md or AGENTS.md — the house style an agent working there should follow.",

  // -- providers ------------------------------------------------------------
  'providers.title': 'Providers',
  'providers.add': 'Add provider',
  'providers.addTitle': 'Add a provider',
  'providers.intro':
    'An agent declares how hard its job is — low, medium, high, max. Each provider maps those levels onto real models, so a workflow moves between providers unchanged.',
  'providers.makeDefault': 'Make default',
  'providers.startFrom': 'Start from',
  'providers.startFromNothing': 'Nothing — configure it by hand',
  'providers.name': 'Name',
  'providers.kind': 'Kind',
  'providers.baseUrl': 'Base URL',
  'providers.baseUrlHint': 'Include the version path. Ollama uses /v1 too.',
  'providers.keyVariable': 'API key environment variable',
  'providers.keyVariableHint':
    'The name of the variable, never the key. Leave blank for local endpoints that need none. The server process reads it, so set it before launching.',
  'providers.modelPerLevel': 'Model for each struggle level',
  'providers.note.claudeCode':
    'The `claude` CLI on this machine. Uses its own login — no key — and is the only kind whose agents can read and change files.',
  'providers.note.anthropic': 'The Anthropic API, via a key in an environment variable. Text only.',
  'providers.note.openai':
    'Anything speaking the OpenAI chat shape: OpenAI, Ollama, LM Studio, vLLM, OpenRouter. Text only.',

  // -- tools ----------------------------------------------------------------
  'tools.title': 'Tools',
  'tools.checkAll': 'Check all',
  'tools.add': 'Add tool',
  'tools.addTitle': 'Add a tool',
  'tools.editTitle': 'Edit {name}',
  'tools.empty':
    'Nothing registered yet. A tool is an MCP server or a command-line program — the Figma MCP, or a CLI an agent should be allowed to run.',
  'tools.check': 'Check',
  'tools.undocumented': 'Agents are told the tool exists but not how to drive it',
  'tools.name': 'Name',
  'tools.namePlaceholder': 'Figma CLI',
  'tools.kind': 'Kind',
  'tools.kindCli': 'Command-line program',
  'tools.kindMcp': 'MCP server',
  'tools.binary': 'Binary',
  'tools.transport': 'Transport',
  'tools.command': 'Command',
  'tools.arguments': 'Arguments',
  'tools.url': 'URL',
  'tools.purpose': 'What it is for',
  'tools.purposePlaceholder': 'Drives Figma Desktop: variables, components, layout.',
  'tools.usage': 'How to drive it',
  'tools.usagePlaceholder':
    'Always start with `figma-cli status`…\n\nThe commands worth knowing, and the order a task uses them.',
  'tools.usageHint':
    'Goes into the prompt of every agent granted this tool. An agent allowed to run a program but never told how will not use it well — this is the part worth writing.',
  'tools.credential': 'Credential',
  'tools.credentialNone': 'None',
  'tools.credentialHint': 'The token stays where it lives; only its id is stored here.',
  'tools.asEnvVar': 'An environment variable on the process.',
  'tools.asHeader': 'A request header.',
  'tools.checkCommand': 'Check command',
  'tools.checkHint': 'Run by Check. Exit zero means working — the last line of its output is shown.',
  'tools.note.cli':
    'A program on this machine. The agent runs it through its shell, and may run only this one binary.',
  'tools.note.mcp': 'An MCP server. Its tools appear in the session directly, named mcp__<id>__*.',

  // -- workflows ------------------------------------------------------------
  'workflows.title': 'Workflows',
  'workflows.import': 'Import',
  'workflows.new': 'New workflow',
  'workflows.newTitle': 'New workflow',
  'workflows.noCredentials':
    'No model credentials — {auth}. Agents can be authored without them, but generating a prompt or running a pipeline needs them.',
  'workflows.empty':
    'No pipelines yet. A workflow is one orchestrator that plans and delegates, plus the agents it can call.',
  'workflows.in': 'In',
  'workflows.out': 'Out',
  'workflows.name': 'Name',
  'workflows.purpose': 'What it is for',
  'workflows.suits': 'Suits',
  'workflows.suitsPlaceholder': 'bug, regression, hotfix',
  'workflows.suitsHint':
    'Comma-separated hints. When a task does not name a workflow, these are matched against the task text to pick one.',
  'workflows.importTitle': 'Import a workflow',
  'workflows.file': 'File',
  'workflows.orPaste': 'Or paste it',
  'workflows.export': 'Export',
  'workflows.addAgent': 'Add agent',
  'workflows.delete': 'Delete',
  'workflows.howItRuns': 'How it runs',
  'workflows.inAndOut': 'In and Out',
  'workflows.outNothing': 'Nothing — this is the end',
  'workflows.outHint':
    'When this pipeline finishes, its result is what the next one starts from — in its own project, which is usually a different one.',
  'workflows.toFix': 'To fix before this can run',
  'workflows.orchestrator': 'Orchestrator',
  'workflows.agents': 'Agents',
  'workflows.addAgentTitle': 'Add an agent',
  'workflows.role': 'Role',
  'workflows.modelScale': 'Model scale',
  'workflows.provider': 'Provider',
  'workflows.resolvesTo': 'On {provider}, "{level}" resolves to {model}.',
  'workflows.noModelConfigured': '{provider} has no model configured for any level.',
  'workflows.pickProvider': 'Pick a provider to see which model each level resolves to.',
  'workflows.needsClaudeCode':
    ' This agent reads/writes files, runs commands, or searches the web, so it can only run on a claude-code provider.',
  'workflows.produces': 'What it produces',
  'workflows.producesPlaceholder': 'A unified diff / the cause with file references',
  'workflows.mayUse': 'What it may use',
  'workflows.useFiles': 'read and write files',
  'workflows.useRun': 'run commands',
  'workflows.useWeb': 'search the web',
  'workflows.spec': 'Spec — what this agent does, in your words',
  'workflows.specPlaceholder':
    'Given a failing test and a repo, find the cause. Read the test, read the code it exercises, and report the specific line at fault. Do not propose a fix.',
  'workflows.generating': 'Writing the prompt…',
  'workflows.generate': 'Generate prompt',
  'workflows.prompt': 'System prompt — what the model receives',
  'workflows.promptPlaceholder': 'Generated from the spec, or write it yourself.',
  'workflows.attach': 'Attach',
  'workflows.detach': 'Detach',
  'workflows.attachTitle': 'Attach a workflow',
  'workflows.nothingToAttach': 'Nothing left to attach.',

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

  // -- the backlog list -----------------------------------------------------
  'items.hideDone': 'Hide done',
  'items.add': 'Add item',
  'items.empty':
    'Nothing captured yet. An item is a Markdown file in the repo — readable in a diff, editable by an agent.',
  'items.new': 'New item',
  'items.title': 'Title',
  'items.titleHint':
    'Captured as a Markdown file with a spec template. Fill in the problem and acceptance criteria before moving it past Backlog.',
  'items.type': 'Type',
  'items.priority': 'Priority',

  // -- the item page --------------------------------------------------------
  'item.unblock': 'Unblock',
  'item.unblocking': 'Unblocking…',
  'item.moveTo': 'Move to',
  'item.spec': 'Spec',
  'item.unsaved': 'unsaved changes',
  'item.currentBody': 'Current body on the server',
  'item.offFlow':
    "This item's status ({state}) is not a state in this project's current flow — only recovery moves are offered below.",
  'item.conflict':
    'This item changed on the server since you started editing. Your draft has not been touched —',
  'item.viewCurrent': 'view the current body',
  'item.beforeDeciding': 'before deciding what to do.',

  // -- states, as the interface names them ----------------------------------
  'state.backlog': 'Backlog',
  'state.specced': 'Specced',
  'state.ready': 'Ready',
  'state.in_progress': 'In progress',
  'state.in_review': 'In review',
  'state.done': 'Done',
  'state.blocked': 'Blocked',
  'state.cancelled': 'Cancelled',

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

  // -- what a run spent -----------------------------------------------------
  'spend.tokensOver': '{tokens} tokens over {runs} runs',
  'spend.input': 'input: {n}',
  'spend.output': 'output: {n}',
  'spend.cacheUnknown': 'cache: unknown',
  'spend.cacheShare': 'cache: {percent}%',

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
