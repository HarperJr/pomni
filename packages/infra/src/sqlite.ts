/**
 * The part of a SQLite connection this needs: somewhere to send a pragma.
 *
 * Structural rather than imported from `node:sqlite`, because every store here declares its
 * own narrow view of that class for the same reason — the module is experimental, and a type
 * imported from it drags in eleven members none of this code touches.
 */
interface Pragmatic {
  exec(sql: string): void;
}

/**
 * The settings every one of Pomni's SQLite connections opens with.
 *
 * In one place because they are a decision rather than boilerplate, and because five stores
 * share one file: a setting that differs between two of them is a difference nobody can see
 * until it matters.
 *
 * **`journal_mode = WAL`** — readers do not block the writer. Pomni has a server, a CLI and
 * agents reading the same database while a run writes to it.
 *
 * **`busy_timeout = 5000`** — with several processes on one file, "locked" is a thing to wait
 * out rather than an error to report. Five seconds is far longer than any write here takes.
 *
 * **`synchronous = NORMAL`** — the one worth reading twice. The default, `FULL`, fsyncs on
 * every commit; measured on this machine that is about 80ms per commit, and a store that
 * applies twenty migrations pays it twenty times. `NORMAL` under WAL fsyncs at checkpoints
 * instead: **a crashed process or a crashed OS still recovers completely**, and what can be
 * lost is the last few transactions in a power cut or a hard reset. Never corruption — WAL
 * either has a transaction or it does not.
 *
 * That trade is right here because this database is not the record of last resort. What a run
 * produced is a git commit; what a project *is* lives in `.pomni`'s own files. These tables
 * are the account of what happened, and an account missing its last seconds after somebody
 * pulled the plug is worth the fourteenfold difference in what every write costs.
 */
export function applyPragmas(db: Pragmatic): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
}
