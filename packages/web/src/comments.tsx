import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Comment, type CommentAuthor } from './api';
import { Alert, errorMessage } from './components';
import { useLanguage } from './i18n';
import { Markdown } from './markdown';

/**
 * The only way an author is put on screen.
 *
 * Mirrors `authorLabel` in core, and for the same reason: an agent's note carries the agent
 * and the run it spoke from, and a person's says so even when the name alone would read as
 * one. A reader must never have to guess which they are looking at.
 */
function authorLabel(author: CommentAuthor, personSuffix: string): string {
  return author.kind === 'agent'
    ? `${author.agentName} · ${author.agentId} · ${author.runId.slice(-8)}`
    : `${author.name} ${personSuffix}`;
}

/**
 * Notes on an item or a run: the thread, and a box to add to it.
 *
 * One component for both subjects — the subject is a field on the comment, and two components
 * would be the same code drifting apart. Withdrawn notes stay in the list as tombstones,
 * because a gap in a thread explains nothing about why an agent did what it did.
 */
export function Comments({
  projectId,
  subject,
  subjectId,
}: {
  projectId: string;
  subject: 'item' | 'run';
  subjectId: string;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [author, setAuthor] = useState('');
  const [addressedTo, setAddressedTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const key = ['comments', subject, subjectId];
  const thread = useQuery({
    queryKey: key,
    // Tombstones included: the component draws them as withdrawn, because a note vanishing
    // without trace is exactly what an append-only record exists to prevent.
    queryFn: () => api.listComments(subject, subjectId, true),
  });

  const write = useMutation({
    mutationFn: () =>
      api.writeComment(projectId, subject, subjectId, {
        text,
        author: author.trim() || undefined,
        addressedTo: addressedTo.trim() || null,
      }),
    onSuccess: async () => {
      setText('');
      setAddressedTo('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => api.deleteComment(id, author.trim() || undefined),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (caught) => setError(errorMessage(caught)),
  });

  const comments = thread.data?.comments ?? [];

  return (
    <div className="card">
      <div className="card-head">{t('comments.title')}</div>
      <div className="comment-body">
        {error && <Alert kind="error">{error}</Alert>}

        {comments.length === 0 ? (
          <p className="dim">{t('comments.none')}</p>
        ) : (
          <ul className="comment-list">
            {comments.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                personSuffix={t('comments.person')}
                onWithdraw={() => withdraw.mutate(comment.id)}
              />
            ))}
          </ul>
        )}

        <div className="comment-compose">
          <textarea
            className="mono"
            rows={3}
            value={text}
            placeholder={t('comments.placeholder')}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="comment-compose-row">
            <input
              value={author}
              placeholder={t('comments.author')}
              onChange={(event) => setAuthor(event.target.value)}
            />
            <input
              value={addressedTo}
              placeholder={t('comments.addressedTo')}
              onChange={(event) => setAddressedTo(event.target.value)}
            />
            <button
              className="primary"
              disabled={!text.trim() || write.isPending}
              onClick={() => write.mutate()}
            >
              {write.isPending ? t('common.saving') : t('comments.write')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  personSuffix,
  onWithdraw,
}: {
  comment: Comment;
  personSuffix: string;
  onWithdraw: () => void;
}) {
  const { t } = useLanguage();
  const withdrawn = comment.deletedAt !== null;

  return (
    <li className={withdrawn ? 'comment comment-withdrawn' : 'comment'}>
      <div className="comment-head">
        <strong>{authorLabel(comment.author, personSuffix)}</strong>
        <span className="dim">{new Date(comment.createdAt).toLocaleString()}</span>
        {comment.addressedTo && (
          <span className="dim">
            → {comment.addressedTo} ({comment.resolvedAt ? t('comments.answered') : t('comments.waiting')})
          </span>
        )}
        {!withdrawn && (
          <button className="ghost" onClick={onWithdraw}>
            {t('comments.withdraw')}
          </button>
        )}
      </div>
      {withdrawn ? (
        <p className="dim">{t('comments.withdrawn')}</p>
      ) : (
        <Markdown className="md-panel" source={comment.text} />
      )}
      {!withdrawn && comment.attachments.length > 0 && (
        <p className="dim">
          {t('comments.attached')}: {comment.attachments.map((file) => file.name).join(', ')}
        </p>
      )}
    </li>
  );
}
