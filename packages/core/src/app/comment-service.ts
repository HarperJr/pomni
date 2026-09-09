import {
  CommentSchema,
  commentsContext,
  MAX_COMMENT_BYTES,
  type Comment,
  type CommentAuthor,
  type CommentFilter,
  type CommentSubject,
  type CommentsSince,
} from '../domain/comment.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { ContextFile } from '../domain/pipeline.js';
import { ulid } from '../domain/ulid.js';
import type { Clock, CommentStore, EventBus, Logger } from '../ports/index.js';

export interface AddCommentInput {
  subject: CommentSubject;
  subjectId: string;
  projectId: string;
  author: CommentAuthor;
  /** Markdown, kept exactly as written. */
  text: string;
  attachments?: ContextFile[];
  /** A person's name. Asks them something without stopping anything. */
  addressedTo?: string | null;
  /** The addressed note this one answers; writing this settles that one. */
  resolvesCommentId?: string | null;
}

/**
 * Notes on items and runs.
 *
 * Everything here is append-only. `delete` writes a tombstone rather than removing a row, and
 * there is no edit at all: an agent acted on what it was told, and a record that can be
 * rewritten afterwards cannot explain why it did.
 */
export class CommentService {
  constructor(
    private readonly store: CommentStore,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  async add(input: AddCommentInput): Promise<Comment> {
    const text = input.text.trim();
    if (!text) {
      throw new ValidationError(
        'a comment needs something in it — write what the next attempt should know, or leave none',
      );
    }

    const size = Buffer.byteLength(text, 'utf8');
    if (size > MAX_COMMENT_BYTES) {
      throw new ValidationError(
        `that comment is ${size} bytes and the limit is ${MAX_COMMENT_BYTES} — attach the long` +
          ' part as a file and say here what it means',
      );
    }

    const addressedTo = input.addressedTo?.trim() || null;

    const comment = CommentSchema.parse({
      id: ulid(this.clock.now().getTime()),
      subject: input.subject,
      subjectId: input.subjectId,
      projectId: input.projectId,
      author: input.author,
      text,
      attachments: input.attachments ?? [],
      addressedTo,
      resolvesCommentId: input.resolvesCommentId ?? null,
      resolvedAt: null,
      resolvedBy: null,
      resolvedByCommentId: null,
      deletedAt: null,
      deletedBy: null,
      createdAt: this.clock.iso(),
    });

    await this.store.insert(comment);

    // A reply settles what it replies to, in the same breath. Doing it here rather than
    // leaving it to a second call is what stops an answered note showing as still waiting.
    if (comment.resolvesCommentId) {
      await this.resolve(comment.resolvesCommentId, comment.author, comment.id);
    }

    this.events.emit({
      type: 'comment.added',
      commentId: comment.id,
      subject: comment.subject,
      subjectId: comment.subjectId,
      projectId: comment.projectId,
      authorKind: comment.author.kind,
      addressedTo: comment.addressedTo,
    });

    return comment;
  }

  /** Oldest first. Tombstones hidden unless the caller asks for them. */
  async list(filter: CommentFilter): Promise<Comment[]> {
    return this.store.list(filter);
  }

  async get(id: string): Promise<Comment> {
    const comment = await this.store.get(id);
    if (!comment) throw new NotFoundError('comment', id);
    return comment;
  }

  /**
   * Withdraw a note. Recorded as a deletion, with who did it and when — the row stays, and
   * every reader stops showing its text.
   *
   * Deleting twice is not an error: the second caller wanted the same end state the first one
   * already produced, and the first deletion is the one that happened.
   */
  async delete(id: string, by: CommentAuthor): Promise<Comment> {
    const existing = await this.get(id);
    if (existing.deletedAt) return existing;

    await this.store.markDeleted(id, { at: this.clock.iso(), by });

    this.events.emit({
      type: 'comment.deleted',
      commentId: existing.id,
      subject: existing.subject,
      subjectId: existing.subjectId,
      projectId: existing.projectId,
    });

    return this.get(id);
  }

  /** What an item is still waiting on a person for, oldest first. */
  async outstanding(itemId: string): Promise<Comment[]> {
    return this.store.outstanding(itemId);
  }

  /**
   * Say an addressed note has been dealt with.
   *
   * `byCommentId` is the reply that settled it, when there was one — a person who answered in
   * words leaves a comment and this points at it; a person who simply did the thing does not.
   */
  async resolve(
    id: string,
    by: CommentAuthor,
    byCommentId: string | null = null,
  ): Promise<Comment> {
    const existing = await this.get(id);
    if (!existing.addressedTo) {
      throw new ValidationError(
        `comment '${id}' was not addressed to anyone, so there is nothing to answer — delete it` +
          ' if it should not be there',
      );
    }

    await this.store.markResolved(id, { at: this.clock.iso(), by, byCommentId });
    return this.get(id);
  }

  /**
   * An item's notes as the file every agent of a run is given, rebuilt from the store.
   *
   * Never carried forward from a previous attempt: a comment written between two attempts must
   * reach the second one, and a note deleted between them must not. `since` is how a rerun
   * says which of them the last attempt had already seen — mixing the two would present a note
   * nobody had read yet as something the previous run already acted on.
   *
   * `undefined` when the item has nothing live to say, which is not the same as an empty file.
   */
  async runContext(
    itemId: string,
    options: { since?: CommentsSince } = {},
  ): Promise<ContextFile | undefined> {
    const comments = await this.store.forRunContext(itemId).catch((error: unknown) => {
      // A run is not worth refusing over unreadable notes: the task and the spec are still
      // there, and the run says less than it could rather than nothing at all.
      this.logger.warn(
        `could not read comments for '${itemId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [] as Comment[];
    });

    return commentsContext(comments, options);
  }
}
